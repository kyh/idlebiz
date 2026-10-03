import { isReady, probeRunners, runnerBin } from "@repo/agent-driver/detect";
import type { RunnerProbe } from "@repo/agent-driver/detect";
import { priceUsage } from "@repo/agent-driver/pricing";
import { RUNNERS } from "@repo/agent-driver/registry";
import type { RunnerAdapter, SessionSetup } from "@repo/agent-driver/registry";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_SESSION_MS,
  RUNNER_IDS,
} from "@repo/agent-driver/runner";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import type {
  AcpAgent,
  AcpTurnEnd,
  PermissionDecision,
  AcpTurnResult,
  PermissionRequest,
} from "@repo/agent-driver/acp-session";
import { addUsage } from "@repo/agent-driver/events";
import type { AgentEvent, AgentUsage } from "@repo/agent-driver/events";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { parseJson } from "@/shared/json";
import { createRequire } from "node:module";
import { controlPlane } from "@/main/control-plane";
import { bundledSkillsDir } from "@/main/agents/bundled-skills";
import { refuseDeniedTools } from "@/main/agents/claude-denies";
import { claudeUserSettings } from "@/main/agents/claude-user-settings";
import { runEnv } from "@/main/agents/run-env";
import { TEAM_NOTES_MAX_BYTES, readTeamNotes } from "@/main/agents/team-notes";
import { teamNotesPrompt } from "@/main/prompts/team-notes";
import {
  browserSocketDir,
  machineSeal,
  namespaceUnder,
  realPathOf,
  SANDBOX_EXEC,
  sealedCommand,
  sealRuns,
  signInCommand,
} from "@/main/agents/seal";
import type { Seal, SealState } from "@/main/agents/seal";
import { report } from "@/main/lib/report";
import type { ToolCaller } from "@/main/control-plane";
import type {
  AgentRunner,
  BlockedAsk,
  Company,
  Employee,
  RestingRunners,
  RunOutcome,
  RunSession,
} from "@/shared/domain";
import * as store from "@/main/store/store";
import { TOOL_CACHE_DIR, employeeMemoryDir } from "@/main/paths";
import { holdFor } from "@/shared/command-policy";
import type { Confinement, LivePage } from "@/shared/command-policy";
import { RefusalError } from "@/shared/refusal";
import { DEPLOY_TIMEOUT_MS } from "@/shared/tool-specs";

// The desktop app ships the ACP binaries, so resolve them against its node_modules.
const resolveFromApp = createRequire(import.meta.url);

// Child processes cannot execute files inside asar; matches electron-builder's asarUnpack.
const unpacked = (file: string): string =>
  file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

/** What of main's env a runner's CLI gets, for a run or a probe of its login alike. */
const runnerEnv = (runner: AgentRunner): Record<string, string> =>
  runEnv(process.env, RUNNERS[runner].providerEnv);

// One temp folder the runs share, outside their working trees: see TOOL_CACHE_ENV.
const RUN_TMPDIR = path.join(TOOL_CACHE_DIR, "tmp");

/**
 * Chrome's own sandbox is one more that cannot start inside the seal. No AGENT_BROWSER_PROFILE:
 * unset, each session's Chrome gets a fresh profile under TMPDIR, never the founder's, while one
 * fixed profile would keep every session but the first from starting, since Chrome locks it.
 * The namespace is that of the run's runner and folders, and so are its daemons: only such runs,
 * or a read made the way one of them would make it, ever start one there. A screenshot named no
 * path lands in the runs' temp folder, not agent-browser's own in HOME, which no run writes.
 */
const browserEnv = (seal: Seal, runner: AgentRunner) => ({
  AGENT_BROWSER_ARGS: "--no-sandbox",
  AGENT_BROWSER_NAMESPACE: namespaceUnder(seal, runner),
  AGENT_BROWSER_SCREENSHOT_DIR: path.join(RUN_TMPDIR, "screenshots"),
  AGENT_BROWSER_SOCKET_DIR: browserSocketDir(),
});

/** The folder the daemons of `runner`'s runs under `seal` listen in, which a run cannot make: only write inside it. */
const makeBrowserNamespace = (seal: Seal, runner: AgentRunner): void => {
  mkdirSync(seal.namespaces[runner].path, { recursive: true });
};

/**
 * Every session an employee runs, a task or a one-shot, starts sealed: sandbox-exec cannot apply
 * a profile inside another, so neither CLI may sandbox its own commands in there. claude's
 * sandbox stays off and codex runs in external-sandbox mode (both in the registry), or every
 * command they run fails. `setup` is where IdleBiz's skills are, and how the founder's claude
 * signs in and which model it picks. `more` joins the adapter's env over main's: for codex, the
 * session config `codexSessionEnv` makes; for claude, the env of their user settings.
 */
export const acpAgentFor = (
  runner: AgentRunner,
  seal: Seal,
  setup: SessionSetup,
  more: Record<string, string> = {},
): AcpAgent => {
  const adapter: RunnerAdapter = RUNNERS[runner];
  const session = adapter.session(setup);
  const env: AcpAgent["env"] = {
    ...runnerEnv(runner),
    ...more,
    ...browserEnv(seal, runner),
    // The packaged executable is Electron; child agents need its Node mode.
    ELECTRON_RUN_AS_NODE: "1",
  };
  if (adapter.binEnvVar) {
    env[adapter.binEnvVar] = runnerBin(runner);
  }
  if (runner === "claude") {
    // claude kills a shell command after 2 minutes by default: a deploy's curl would die before
    // Vercel answers, with the founder's sign-off already spent on it
    env.BASH_DEFAULT_TIMEOUT_MS = String(DEPLOY_TIMEOUT_MS + 60_000);
  }
  return {
    command: sealedCommand(seal, runner, [
      process.execPath,
      unpacked(resolveFromApp.resolve(adapter.acpEntry)),
    ]),
    env,
    readDirs: session.readDirs,
    sessionMeta: session.meta,
    sessionModeId: adapter.sessionModeId,
    typedFailures: adapter.typedFailures,
    usagePerRequest: adapter.usagePerRequest,
  };
};

const acpAgentInstalled = (runner: AgentRunner): boolean => {
  try {
    resolveFromApp.resolve(RUNNERS[runner].acpEntry);
    return true;
  } catch {
    return false;
  }
};

const execFileAsync = promisify(execFile);

const CodexMcpServers = z.array(z.object({ name: z.string() }));

const ExecFailure = z.object({ stderr: z.string() });

/** Why codex could not list its servers, in words the founder can act on. */
const unlisted = (why: string): RefusalError =>
  new RefusalError(
    `IdleBiz could not list your codex MCP servers to keep them out of the run (${why}), so it did not start.`,
  );

/**
 * The session config that turns off every server `listed` (what `codex mcp list --json` printed)
 * names; apps and plugins, which bring servers of their own, and skills the seal leaves a run to
 * read (plugins keep theirs in `plugins/cache`); and memories, which would put what the founder's
 * own sessions taught codex into the run's prompt. It reads a workspace's notes as a claude run is
 * handed them (`readTeamNotes`): `AGENTS.md` or its override, never another name their config
 * falls back to, and as much of it.
 */
export const codexSessionConfig = (listed: string) => {
  let servers: z.infer<typeof CodexMcpServers>;
  try {
    servers = CodexMcpServers.parse(parseJson(listed));
  } catch {
    throw unlisted("codex answered in a shape IdleBiz does not read");
  }
  const config = {
    features: { apps: false, memories: false, plugins: false },
    mcp_servers: Object.fromEntries(servers.map(({ name }) => [name, { enabled: false }])),
    project_doc_fallback_filenames: [],
    project_doc_max_bytes: TEAM_NOTES_MAX_BYTES,
  };
  return { CODEX_CONFIG: JSON.stringify(config) };
};

/**
 * The adapter env whose session config keeps every MCP server of the founder's out of a codex run
 * (`codexSessionConfig`): they act as the founder, signed in as them. codex has no switch that
 * loads none, and a session's config is merged over theirs, so each is turned off by the name
 * `codex mcp list` gives it, listed as the run would load them (`env` is the run's own, a
 * CODEX_HOME in it included).
 */
export const codexSessionEnv = async (
  seal: Seal,
  env: Record<string, string> = {},
): Promise<Record<string, string>> => {
  const [bin = SANDBOX_EXEC, ...rest] = sealedCommand(seal, "codex", [
    runnerBin("codex"),
    "mcp",
    "list",
    "--json",
  ]);
  let listed: string;
  try {
    ({ stdout: listed } = await execFileAsync(bin, rest, {
      env: { ...runnerEnv("codex"), ...env },
      timeout: 15_000,
    }));
  } catch (error) {
    const failed = ExecFailure.safeParse(error);
    const [said = ""] = failed.success ? failed.data.stderr.trim().split("\n", 1) : [];
    throw unlisted(said === "" ? "codex did not answer" : said);
  }
  return codexSessionConfig(listed);
};

/**
 * `runner`'s session under `seal`, loading the skills in `skills` and none of the founder's, nor
 * any MCP server of theirs, but signing in as their CLI does, and handed the notes the team keeps
 * in `workspace`, where it works on a product.
 */
export const sessionAgent = async (
  runner: AgentRunner,
  seal: Seal,
  skills: string,
  workspace: string | null,
): Promise<AcpAgent> => {
  if (runner === "codex") {
    const setup = { skills, teamNotes: null, userSettings: {} };
    return acpAgentFor(runner, seal, setup, await codexSessionEnv(seal));
  }
  const { env, settings } = await claudeUserSettings(seal.runners.claude.folder);
  const notes = workspace === null ? null : await readTeamNotes(workspace);
  const setup = {
    skills,
    teamNotes: notes === null ? null : teamNotesPrompt(notes),
    userSettings: settings,
  };
  return acpAgentFor(runner, seal, setup, env);
};

/**
 * The URL of the top page, then of every frame found under it; null where the
 * reading frame's origin may not look. `get url` names only the top page, while a
 * ref act can land in any frame. The walk starts at `top`, wherever the session is
 * switched. `window.frames` leaves out frames in shadow roots, and a page's own
 * `var length` hides the rest, so each readable document is searched as well, open
 * roots included; a frame in a closed root shows only in resource timing, once it
 * has loaded, by the URL it first asked for; frames inside it not at all.
 */
export const PAGE_URLS = `(() => {
  const urls = [];
  const seen = new Set();
  const walk = (w) => {
    if (w == null || seen.has(w)) return;
    seen.add(w);
    let url = null;
    let doc = null;
    try { url = w.location.href; doc = w.document; } catch {}
    urls.push(url);
    for (let i = 0; i < w.length; i += 1) walk(w[i]);
    if (doc === null) return;
    const roots = [doc];
    for (let root = roots.pop(); root !== undefined; root = roots.pop()) {
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (el.contentWindow) walk(el.contentWindow);
      }
    }
    for (const entry of w.performance.getEntriesByType("resource")) {
      if (["iframe", "frame", "object", "embed"].includes(entry.initiatorType)) urls.push(entry.name);
    }
  };
  walk(window.top);
  return urls;
})()`;

/** agent-browser's answer to these words: what it printed. */
export type BrowserCli = (args: readonly string[]) => Promise<string>;

/** agent-browser as a `runner` run starts it: under its seal, in its env. */
const sealedBrowser =
  (seal: Seal, runner: AgentRunner): BrowserCli =>
  async (args) => {
    const [bin = SANDBOX_EXEC, ...rest] = sealedCommand(seal, runner, ["agent-browser", ...args]);
    const env = { ...runnerEnv(runner), ...browserEnv(seal, runner) };
    const { stdout } = await execFileAsync(bin, rest, { env, timeout: 8000 });
    return stdout;
  };

const SessionInfo = z.object({ data: z.object({ active: z.boolean() }) });

const LivePageOutput = z.object({ data: z.object({ result: z.array(z.string().nullable()) }) });

/** The page `session` in `namespace` shows, read through `browser`; null when nothing could say. */
const readPage = async (
  browser: BrowserCli,
  namespace: string,
  session: string,
): ReturnType<LivePage> => {
  const scope = ["--namespace", namespace, ...(session === "" ? [] : ["--session", session])];
  try {
    const info = SessionInfo.safeParse(
      parseJson(await browser([...scope, "session", "info", "--json"])),
    );
    if (!info.success || !info.data.data.active) {
      return null;
    }
    const page = LivePageOutput.safeParse(
      parseJson(await browser([...scope, "eval", PAGE_URLS, "--json"])),
    );
    const [url = null, ...frames] = page.success ? page.data.data.result : [];
    return url === null ? null : { frames, url };
  } catch {
    return null;
  }
};

/**
 * Ask the browser itself: the session is the run's, but any process of this user can read it.
 * Only a daemon already running is read, since `eval` starts one where none runs: a session with
 * no daemon shows no page, so an act on it waits on the founder. `browser` is agent-browser as
 * the run starts it, so a daemon that stops between the two reads comes back sealed all the same.
 */
export const livePageOf =
  (browser: BrowserCli, namespace: string): LivePage =>
  (session) =>
    readPage(browser, namespace, session);

/** An approval permits one execution of the exact command, or — for a site or a server — the rest of the run. */
export const decidePermission = async (
  task: { companyId: string; id: string },
  request: PermissionRequest,
  leases: Set<string>,
  livePage: LivePage,
  confinement: Confinement,
  hold: (ask: BlockedAsk) => void,
  signal: AbortSignal,
): Promise<PermissionDecision> => {
  if (request.tool.kind === "sandbox") {
    return { allow: false };
  }
  const held = await holdFor(request.tool, leases, livePage, confinement);
  // reading the browser can outlast the turn; its sign-off and its ask belong to a live one
  if (signal.aborted) {
    return { allow: false };
  }
  if (held === null) {
    return { allow: true };
  }
  if (store.consumeApproval(task.id, held.key)) {
    if (held.leasable) {
      leases.add(held.key);
    }
    return { allow: true };
  }
  hold({ command: held.key, rule: held.rule, type: "approval" });
  return { allow: false };
};

/** Prefer reported dollars; otherwise price tokens at the runner's default model. */
const priceRun = (emp: Employee, usage: AgentUsage): number => {
  if (usage.costUsd > 0) {
    return usage.costUsd;
  }
  if (usage.inputTokens + usage.outputTokens === 0) {
    return 0;
  }
  return priceUsage(RUNNERS[emp.runner].fallbackRates, usage);
};

// One cache the runs share, outside their working trees and apart from the founder's: a package
// a run installs never lands in a store the founder's own projects link from. A run writes only
// its own folders, so every cache a toolchain would keep in HOME is moved here, and updaters that
// would rewrite a CLI the founder runs are off. TMPDIR is moved too: a run connects only to
// sockets in its own folders, and the founder's TMPDIR is full of theirs.
const TOOL_CACHE_ENV = {
  BUN_INSTALL_CACHE_DIR: path.join(TOOL_CACHE_DIR, "bun"),
  COREPACK_HOME: path.join(TOOL_CACHE_DIR, "corepack"),
  DISABLE_AUTOUPDATER: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  PLAYWRIGHT_BROWSERS_PATH: path.join(TOOL_CACHE_DIR, "ms-playwright"),
  TMPDIR: RUN_TMPDIR,
  XDG_CACHE_HOME: TOOL_CACHE_DIR,
  npm_config_cache: path.join(TOOL_CACHE_DIR, "npm"),
  npm_config_devdir: path.join(TOOL_CACHE_DIR, "node-gyp"),
  npm_config_update_notifier: "false",
  pnpm_config_store_dir: path.join(TOOL_CACHE_DIR, "pnpm-store"),
};

/**
 * A product's workspace as a repository, made by main when it is none yet: a run cannot write a
 * repository's config or hooks, which the founder's own git would run. macOS's git, whose `init`
 * runs nothing the folder holds. Without Apple's command line tools it has no git to run, and the
 * run goes on in a plain folder rather than fail every attempt.
 */
export const ensureRepository = async (workspace: string): Promise<void> => {
  const stats = await lstat(path.join(workspace, ".git")).catch(() => null);
  if (stats === null) {
    try {
      await execFileAsync("/usr/bin/git", ["init", "--quiet"], { cwd: workspace });
    } catch (error) {
      report("repository", error);
    }
  }
};

/**
 * Who a run's commits name, since it cannot write git's config to say so. Nor do they sign:
 * the founder's global config may sign every commit and tag with keys the seal hides, which
 * would fail each one.
 */
export const gitIdentity = (emp: Employee, company: Company) => {
  const email = `${emp.id}@${company.id}.idlebiz.invalid`;
  return {
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_NAME: emp.name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_NAME: emp.name,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "commit.gpgSign",
    GIT_CONFIG_KEY_1: "tag.gpgSign",
    GIT_CONFIG_KEY_2: "tag.forceSignAnnotated",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_VALUE_2: "false",
  };
};

/**
 * How a turn ended, as the scheduler settles it. An ask outranks everything: the
 * founder's answer is what the task waits on. A turn the app stopped failed only
 * because it was stopped, so it is not the task's failure.
 */
export const outcomeOf = (
  end: AcpTurnResult["end"],
  ask: BlockedAsk | null,
  interrupted: boolean,
): RunOutcome => {
  if (ask) {
    return { ask, kind: "blocked" };
  }
  if (end.kind === "completed") {
    return { kind: "done" };
  }
  if (interrupted) {
    return { kind: "interrupted" };
  }
  switch (end.kind) {
    case "limited": {
      return { error: end.error, kind: "resting", until: end.resetsAt };
    }
    case "signedOut": {
      return { error: end.error, kind: "signedOut" };
    }
    case "failed": {
      return { error: end.error, kind: "failed" };
    }
    // no default
  }
};

/** The first thing a run asks the founder is the one they answer; later asks in the same run are dropped. */
export interface AskBox {
  /** False when the run had already asked, and this ask was dropped. */
  raise: (ask: BlockedAsk) => boolean;
  current: () => BlockedAsk | null;
}

export const askBox = (onFirst: (ask: BlockedAsk) => void): AskBox => {
  let first: BlockedAsk | null = null;
  return {
    current: () => first,
    raise: (ask) => {
      if (first !== null) {
        return false;
      }
      first = ask;
      onFirst(ask);
      return true;
    },
  };
};

/** What a run can reach of the company: its tools over its own socket, and the one ask it may leave the founder. */
export interface RunTools {
  call: ToolCaller;
  asks: AskBox;
}

export interface RunResult {
  outcome: RunOutcome;
  summary: string;
  /** The session to remember for this employee after the run; null forgets it. */
  session: RunSession | null;
  /** Digest of the instructions that session now holds. */
  instructionsDigest: string | null;
  usage: AgentUsage;
}

type Memory = Pick<RunResult, "session" | "instructionsDigest">;

/**
 * What an employee remembers after a turn: the session it ran, holding the instructions it was
 * given. A turn that opened none leaves `stored` exactly as it was; a spent session is forgotten.
 */
export const memoryAfter = (
  turn: Pick<AcpTurnResult, "end" | "sessionId">,
  stored: Memory,
  digest: string,
  workspace: string,
): Memory => {
  if (turn.end.kind === "failed" && turn.end.sessionSpent) {
    return { instructionsDigest: null, session: null };
  }
  return turn.sessionId === undefined
    ? stored
    : { instructionsDigest: digest, session: { id: turn.sessionId, workspace } };
};

/**
 * The session a run in `workspace` resumes. Only one begun there: claude resumes a session from
 * any folder but the seal lets a run write only its own folder's transcripts, so a turn resumed
 * elsewhere is never recorded and the next resume has forgotten it.
 */
export const resumeIn = (session: RunSession | null, workspace: string): string | undefined =>
  session?.workspace === workspace ? session.id : undefined;

class AgentDriver {
  // Boot probes in the background; callers needing a definitive answer await probing.
  private probes: RunnerProbe[] = [];
  private probing: Promise<RunnerProbe[]> = Promise.resolve([]);
  private sealing: Promise<SealState> = Promise.resolve({
    kind: "refused",
    reason: "IdleBiz has not sealed employee runs yet, so none will start.",
  });
  /** What the latest settled check found; null before the first settles. */
  private sealed: SealState | null = null;
  // runner -> epoch its limit lifts
  private readonly restingUntil = new Map<AgentRunner, number>();
  // runners whose login a turn found refused; only a sign-in clears one, since its probe reads
  // the stored login, which a revoked token still is
  private readonly refusedLogins = new Set<AgentRunner>();
  private readonly checkSeal: () => Promise<SealState>;
  private readonly resolveSeal: (
    writable: readonly string[],
    apiSocket: string | null,
  ) => Promise<Seal>;
  private readonly skills: () => string;

  constructor(
    checkSeal: () => Promise<SealState>,
    resolveSeal: (writable: readonly string[], apiSocket: string | null) => Promise<Seal>,
    skills: () => string,
  ) {
    this.checkSeal = checkSeal;
    this.resolveSeal = resolveSeal;
    this.skills = skills;
  }

  /** Runs wait on the seal's check, and never start unsealed. */
  init(): void {
    this.sealing = this.settleSeal();
    this.probing = this.probe();
  }

  /** A refusal is written to main's log as well as told to the founder. */
  private async settleSeal(): Promise<SealState> {
    const state = await this.checkSeal();
    if (state.kind === "refused") {
      report("seal", state.reason);
    }
    this.sealed = state;
    return state;
  }

  /**
   * Each CLI is looked for under its runner's seal, as a run starts it, since the one on PATH
   * could be a run's plant: with no seal, none is found.
   */
  private async probe(): Promise<RunnerProbe[]> {
    let probes: RunnerProbe[] = [];
    try {
      const seal = await this.seal([]);
      probes = await probeRunners(runnerEnv, (runner, argv) => sealedCommand(seal, runner, argv));
    } catch (error) {
      // a refusal is reported where the check settles
      if (!(error instanceof RefusalError)) {
        report("probe", error);
      }
    }
    this.probes = probes;
    return probes;
  }

  /** `argv` as main starts `runner`'s CLI itself, to sign it in: under a seal of no folders, free to open the browser. */
  async sealedSignIn(runner: AgentRunner, argv: readonly string[]): Promise<string[]> {
    return signInCommand(await this.seal([]), runner, argv);
  }

  /** Look for the CLIs again, and check again a seal that refused runs: its probe can time out on a loaded boot. */
  refresh(): Promise<RunnerProbe[]> {
    if (this.sealed?.kind === "refused") {
      this.sealing = this.settleSeal();
    }
    this.probing = this.probe();
    return this.probing;
  }

  /** Whether a run may start now: only once a check found the seal holding, which it then always does. */
  runsSealed(): boolean {
    return this.sealed?.kind === "sealed";
  }

  /** Why no run starts, once the latest check settles; null when runs start sealed. */
  async sealRefusal(): Promise<string | null> {
    const state = await this.sealing;
    return state.kind === "refused" ? state.reason : null;
  }

  /**
   * The seal a run writing `writable` and calling the company on `apiSocket` starts under,
   * resolved for that run once the check holds.
   */
  private async seal(writable: readonly string[], apiSocket: string | null = null): Promise<Seal> {
    const state = await this.sealing;
    if (state.kind === "refused") {
      throw new RefusalError(state.reason);
    }
    return await this.resolveSeal(writable, apiSocket);
  }

  async hasAnyRunner(): Promise<boolean> {
    await this.probing;
    return this.availableRunners().length > 0;
  }

  /**
   * Whether `runner`'s CLI was last found signed in as its runs sign in, under its seal: one that
   * is not (a codex login in the Keychain, which the seal closes to codex runs, reads so) would
   * only fail each attempt, so its employees' work waits until a sign-in finds it again.
   */
  signedIn(runner: AgentRunner): boolean {
    return this.availableRunners().includes(runner);
  }

  availableRunners(): AgentRunner[] {
    // A signed-in CLI still needs its separately packaged ACP adapter.
    return this.probes
      .filter((p) => isReady(p) && acpAgentInstalled(p.id) && !this.refusedLogins.has(p.id))
      .map((p) => p.id);
  }

  /** The runners not signed in, once the latest look for the CLIs settles: whoever runs on one waits. */
  async signedOut(): Promise<AgentRunner[]> {
    await this.probing;
    return RUNNER_IDS.filter((runner) => !this.signedIn(runner));
  }

  /** Whether `probe`'s CLI needs a sign-in: installed, and either not signed in or signed in with a login a turn found refused. */
  needsSignIn(probe: RunnerProbe): boolean {
    return probe.installed && (!probe.authed || this.refusedLogins.has(probe.id));
  }

  /** The founder signed `runner` in again, so its turns may try the login anew. */
  signedInAgain(runner: AgentRunner): void {
    this.refusedLogins.delete(runner);
  }

  /** Round-robin across ready runners, preferring those without a usage limit. */
  pickRunner(index: number): AgentRunner {
    const available = this.availableRunners();
    const awake = available.filter((r) => this.restingRunner(r) === null);
    const pool = awake.length > 0 ? awake : available;
    const runner = pool[index % pool.length];
    if (runner === undefined) {
      throw new Error("no signed-in coding CLI to run on");
    }
    return runner;
  }

  restingRunners(): RestingRunners {
    const resting: RestingRunners = {};
    for (const runner of RUNNER_IDS) {
      const until = this.restingRunner(runner);
      if (until !== null) {
        resting[runner] = until;
      }
    }
    return resting;
  }

  /** Epoch until which this runner's usage limit holds, or null if it's awake. */
  restingRunner(runner: AgentRunner): number | null {
    const until = this.restingUntil.get(runner);
    if (until === undefined) {
      return null;
    }
    if (until <= Date.now()) {
      this.restingUntil.delete(runner);
      return null;
    }
    return until;
  }

  /**
   * What a turn's end says of its runner, whatever else the run says: a limit rests it, and a
   * refused login reads as signed out until the founder signs it in again.
   */
  heed(runner: AgentRunner, end: AcpTurnEnd): void {
    if (end.kind === "limited") {
      this.restingUntil.set(runner, end.resetsAt);
    }
    if (end.kind === "signedOut") {
      this.refusedLogins.add(runner);
    }
  }

  /** One turn with no tools, files or memory: its final message, or a throw with why it ended short. */
  async completeOneShot(prompt: string): Promise<string> {
    const runner = this.pickRunner(0);
    const res = await runAcpTurn({
      agent: await sessionAgent(runner, await this.seal([]), this.skills(), null),
      cwd: tmpdir(),
      idleTimeoutMs: 3 * 60_000,
      maxSessionMs: 5 * 60_000,
      onEvent: () => {
        /* empty */
      },
      onPermission: () => Promise.resolve({ allow: false }),
      prompt,
      systemPrompt: "",
    });
    this.heed(runner, res.end);
    if (res.end.kind !== "completed") {
      throw new Error(res.end.error);
    }
    return res.summary;
  }

  async runTask(
    emp: Employee,
    company: Company,
    task: { id: string; title: string; description: string; workspace: string },
    onEvent: (e: AgentEvent) => void,
    tools: RunTools,
    signal: AbortSignal,
  ): Promise<RunResult> {
    const prompt = `${task.title}\n\n${task.description}`.trim();
    const resumeId = resumeIn(emp.session, task.workspace);
    // read at the start, so a change made while the run works reaches the next one
    const instructions = store.employeeInstructions(emp.id);
    const digest = createHash("sha256").update(instructions).digest("hex");
    const run = {
      instructions,
      instructionsChanged: emp.instructionsDigest !== digest,
      prompt,
      taskId: task.id,
      workspace: task.workspace,
    };
    const first = await this.invoke(emp, company, run, onEvent, tools, resumeId, signal);
    // A resumed session that dies without producing any output is almost
    // always stale on the agent's side — retry once fresh before failing.
    const retryFresh =
      first.result.outcome.kind === "failed" && first.turn.resumed && !first.sawOutput;
    if (!retryFresh) {
      const stored = { instructionsDigest: emp.instructionsDigest, session: emp.session };
      return { ...first.result, ...memoryAfter(first.turn, stored, digest, task.workspace) };
    }
    const retry = await this.invoke(emp, company, run, onEvent, tools, undefined, signal);
    // the stale attempt was still billed; each attempt is already priced, so add, don't re-price
    return {
      ...retry.result,
      ...memoryAfter(
        retry.turn,
        { instructionsDigest: digest, session: null },
        digest,
        task.workspace,
      ),
      usage: addUsage(first.result.usage, retry.result.usage),
    };
  }

  private async invoke(
    emp: Employee,
    company: Company,
    run: {
      instructions: string;
      instructionsChanged: boolean;
      prompt: string;
      taskId: string;
      workspace: string;
    },
    onEvent: (e: AgentEvent) => void,
    tools: RunTools,
    resumeSessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    result: Omit<RunResult, "session" | "instructionsDigest">;
    turn: AcpTurnResult;
    sawOutput: boolean;
  }> {
    // the product's workspace is the cwd; the company workspace stays reachable
    // for what is shared across products
    const shared = run.workspace === company.workspaceDir ? [] : [company.workspaceDir];
    const memory = employeeMemoryDir(company.id, emp.id);
    const addDirs = [...shared, memory, TOOL_CACHE_DIR];
    const confinement = {
      cwd: run.workspace,
      real: realPathOf,
      writable: [run.workspace, ...addDirs],
    };
    // a run cannot make its own folders, only write in them
    mkdirSync(memory, { recursive: true });
    mkdirSync(RUN_TMPDIR, { recursive: true });
    // the run's own socket, which its seal alone lets it connect to: the boundary between runs
    const handle = await controlPlane.registerRun(tools.call);
    const leases = new Set<string>();
    let sawOutput = false;
    try {
      const seal = await this.seal(confinement.writable, handle.socket);
      if (emp.runner === "claude") {
        await refuseDeniedTools();
      }
      makeBrowserNamespace(seal, emp.runner);
      if (emp.runner === "claude") {
        // where claude keeps each folder's transcripts and memory, which a run cannot make
        mkdirSync(seal.claudeProjects.projects, { recursive: true });
      }
      if (run.workspace !== company.workspaceDir) {
        await ensureRepository(run.workspace);
      }
      const livePage = livePageOf(
        sealedBrowser(seal, emp.runner),
        namespaceUnder(seal, emp.runner),
      );
      const res = await runAcpTurn({
        addDirs,
        agent: await sessionAgent(emp.runner, seal, this.skills(), run.workspace),
        cwd: run.workspace,
        env: { ...handle.env, ...TOOL_CACHE_ENV, ...gitIdentity(emp, company) },
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
        instructionsChanged: run.instructionsChanged,
        maxSessionMs: DEFAULT_MAX_SESSION_MS,
        onEvent: (e) => {
          sawOutput = true;
          // a listener must never break the run
          try {
            onEvent(e);
          } catch (error) {
            report("run.onEvent", error);
          }
        },
        onPermission: (request, turnEnded) =>
          decidePermission(
            { companyId: company.id, id: run.taskId },
            request,
            leases,
            livePage,
            confinement,
            tools.asks.raise,
            turnEnded,
          ),
        prompt: run.prompt,
        resumeSessionId,
        signal,
        systemPrompt: run.instructions,
      });
      const usage = { ...res.usage, costUsd: priceRun(emp, res.usage) };
      // an ask raised before the limit hit or the login was refused must not hide it
      this.heed(emp.runner, res.end);
      const outcome = outcomeOf(res.end, tools.asks.current(), signal.aborted);
      return { result: { outcome, summary: res.summary, usage }, sawOutput, turn: res };
    } finally {
      handle.release();
    }
  }
}

/**
 * A driver whose runs start only once `checkSeal` finds the seal holding, each under the seal
 * `resolveSeal` gives its own folders then, loading the skills in the folder `skills` names:
 * tests script all three, the app checks and resolves this machine's and the bundled skills.
 */
export const createAgentDriver = (
  checkSeal: () => Promise<SealState> = sealRuns,
  resolveSeal: (
    writable: readonly string[],
    apiSocket: string | null,
  ) => Promise<Seal> = machineSeal,
  skills: () => string = bundledSkillsDir,
): AgentDriver => new AgentDriver(checkSeal, resolveSeal, skills);

export const agentDriver = createAgentDriver();
