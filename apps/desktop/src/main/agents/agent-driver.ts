import { isReady, probeRunners, runnerBin } from "@repo/agent-driver/detect";
import type { RunnerProbe } from "@repo/agent-driver/detect";
import { priceUsage } from "@repo/agent-driver/pricing";
import { RUNNERS } from "@repo/agent-driver/registry";
import type { RunnerAdapter } from "@repo/agent-driver/registry";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_SESSION_MS,
  RUNNER_IDS,
} from "@repo/agent-driver/runner";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import type {
  AcpAgent,
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
import { runEnv } from "@/main/agents/run-env";
import {
  browserNamespace,
  browserSocketDir,
  machineSeal,
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
import { ROOT_DIR, employeeMemoryDir } from "@/main/paths";
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

/**
 * Chrome's own sandbox is one more that cannot start inside the seal. No AGENT_BROWSER_PROFILE:
 * unset, each session's Chrome gets a fresh profile under TMPDIR, never the founder's, while one
 * fixed profile would keep every session but the first from starting, since Chrome locks it.
 * The namespace is the runner's own, and so are its daemons: only its runs, or a read made the
 * way one of them would make it, ever start one there.
 */
const browserEnv = (runner: AgentRunner) => ({
  AGENT_BROWSER_ARGS: "--no-sandbox",
  AGENT_BROWSER_NAMESPACE: browserNamespace(ROOT_DIR, runner),
  AGENT_BROWSER_SOCKET_DIR: browserSocketDir(),
});

/** The folder `runner`'s daemons listen in, which a run cannot make: only write inside it. */
const makeBrowserNamespace = (runner: AgentRunner): void => {
  mkdirSync(path.join(browserSocketDir(), "namespaces", browserNamespace(ROOT_DIR, runner)), {
    recursive: true,
  });
};

/**
 * Every session an employee runs, a task or a one-shot, starts sealed: sandbox-exec cannot apply
 * a profile inside another, so neither CLI may sandbox its own commands in there. claude's
 * sandbox stays off and codex runs in external-sandbox mode (both in the registry), or every
 * command they run fails. `more` joins the adapter's env: for codex, the founder's MCP servers
 * `codexMcpOff` turns off.
 */
export const acpAgentFor = (
  runner: AgentRunner,
  seal: Seal,
  more: Record<string, string> = {},
): AcpAgent => {
  const adapter: RunnerAdapter = RUNNERS[runner];
  const env: AcpAgent["env"] = {
    ...runnerEnv(runner),
    ...browserEnv(runner),
    ...more,
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
    sessionMeta: adapter.sessionMeta,
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
 * names, and the apps and plugins that bring servers of their own.
 */
export const mcpOffConfig = (listed: string) => {
  let servers: z.infer<typeof CodexMcpServers>;
  try {
    servers = CodexMcpServers.parse(parseJson(listed));
  } catch {
    throw unlisted("codex answered in a shape IdleBiz does not read");
  }
  const config = {
    features: { apps: false, plugins: false },
    mcp_servers: Object.fromEntries(servers.map(({ name }) => [name, { enabled: false }])),
  };
  return { CODEX_CONFIG: JSON.stringify(config) };
};

/**
 * The adapter env that keeps every MCP server of the founder's out of a codex run: they act as
 * the founder, signed in as them. codex has no switch that loads none, and a session's config is
 * merged over theirs, so each is turned off by the name `codex mcp list` gives it, listed as the
 * run would load them (`env` is the run's own, a CODEX_HOME in it included).
 */
export const codexMcpOff = async (
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
  return mcpOffConfig(listed);
};

/** `runner`'s session under `seal`, loading none of the founder's MCP servers. */
const sessionAgent = async (runner: AgentRunner, seal: Seal): Promise<AcpAgent> =>
  runner === "claude"
    ? acpAgentFor(runner, seal)
    : acpAgentFor(runner, seal, await codexMcpOff(seal));

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
    const env = { ...runnerEnv(runner), ...browserEnv(runner) };
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
const TOOL_CACHE_DIR = path.join(ROOT_DIR, "cache");

const RUN_TMPDIR = path.join(TOOL_CACHE_DIR, "tmp");

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
  return end.kind === "limited"
    ? { error: end.error, kind: "resting", until: end.resetsAt }
    : { error: end.error, kind: "failed" };
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

/** What a run can reach of the company: its tools over the loopback API, and the one ask it may leave the founder. */
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
  private readonly checkSeal: () => Promise<SealState>;
  private readonly resolveSeal: (writable: readonly string[]) => Promise<Seal>;

  constructor(
    checkSeal: () => Promise<SealState>,
    resolveSeal: (writable: readonly string[]) => Promise<Seal>,
  ) {
    this.checkSeal = checkSeal;
    this.resolveSeal = resolveSeal;
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

  /** The seal a run writing `writable` starts under, resolved for that run once the check holds. */
  private async seal(writable: readonly string[]): Promise<Seal> {
    const state = await this.sealing;
    if (state.kind === "refused") {
      throw new RefusalError(state.reason);
    }
    return await this.resolveSeal(writable);
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
    return this.probes.filter((p) => isReady(p) && acpAgentInstalled(p.id)).map((p) => p.id);
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

  /** Park a runner until its usage limit lifts; pickRunner prefers the awake ones meanwhile. */
  rest(runner: AgentRunner, until: number): void {
    this.restingUntil.set(runner, until);
  }

  /** One turn with no tools, files or memory: its final message, or a throw with why it ended short. */
  async completeOneShot(prompt: string): Promise<string> {
    const runner = this.pickRunner(0);
    const res = await runAcpTurn({
      agent: await sessionAgent(runner, await this.seal([])),
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
    if (res.end.kind === "limited") {
      this.rest(runner, res.end.resetsAt);
    }
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
    const seal = await this.seal(confinement.writable);
    makeBrowserNamespace(emp.runner);
    if (emp.runner === "claude") {
      // where claude keeps each folder's transcripts and memory, which a run cannot make
      mkdirSync(seal.claudeProjects.projects, { recursive: true });
    }
    if (run.workspace !== company.workspaceDir) {
      await ensureRepository(run.workspace);
    }
    const livePage = livePageOf(
      sealedBrowser(seal, emp.runner),
      browserNamespace(ROOT_DIR, emp.runner),
    );
    const handle = controlPlane.registerRun(tools.call);
    const leases = new Set<string>();
    let sawOutput = false;
    try {
      const res = await runAcpTurn({
        addDirs,
        agent: await sessionAgent(emp.runner, seal),
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
      // parked whatever else the run says: an ask raised before the limit hit must not hide it
      if (res.end.kind === "limited") {
        this.rest(emp.runner, res.end.resetsAt);
      }
      const outcome = outcomeOf(res.end, tools.asks.current(), signal.aborted);
      return { result: { outcome, summary: res.summary, usage }, sawOutput, turn: res };
    } finally {
      handle.release();
    }
  }
}

/**
 * A driver whose runs start only once `checkSeal` finds the seal holding, each under the seal
 * `resolveSeal` gives its own folders then: tests script both, the app checks and resolves this
 * machine's.
 */
export const createAgentDriver = (
  checkSeal: () => Promise<SealState> = sealRuns,
  resolveSeal: (writable: readonly string[]) => Promise<Seal> = machineSeal,
): AgentDriver => new AgentDriver(checkSeal, resolveSeal);

export const agentDriver = createAgentDriver();
