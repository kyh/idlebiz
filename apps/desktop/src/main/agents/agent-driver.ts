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
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { parseJson } from "@/shared/json";
import { createRequire } from "node:module";
import { controlPlane } from "@/main/control-plane";
import { runEnv } from "@/main/agents/run-env";
import { SANDBOX_EXEC, sealRuns, sealedCommand } from "@/main/agents/seal";
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
} from "@/shared/domain";
import * as store from "@/main/store/store";
import { ROOT_DIR, employeeMemoryDir } from "@/main/paths";
import { holdFor } from "@/shared/command-policy";
import type { Confinement, LivePage } from "@/shared/command-policy";
import { RefusalError } from "@/shared/refusal";

// The desktop app ships the ACP binaries, so resolve them against its node_modules.
const resolveFromApp = createRequire(import.meta.url);

// Child processes cannot execute files inside asar; matches electron-builder's asarUnpack.
const unpacked = (file: string): string =>
  file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

/** What of main's env a runner's CLI gets, for a run or a probe of its login alike. */
const runnerEnv = (runner: AgentRunner): Record<string, string> =>
  runEnv(process.env, RUNNERS[runner].providerEnv);

/**
 * The agent-browser daemon runs drive, apart from the founder's own. Whoever starts a daemon
 * decides whether its Chrome is sealed, and only a run, or a read made the way a run would make
 * it, ever starts this one. Short: the daemon's socket path under it must fit in 103 bytes.
 */
export const BROWSER_NAMESPACE = `idlebiz-${createHash("sha256").update(ROOT_DIR).digest("hex").slice(0, 8)}`;

/**
 * Chrome's own sandbox is one more that cannot start inside the seal. No AGENT_BROWSER_PROFILE:
 * unset, each session's Chrome gets a fresh profile under TMPDIR, never the founder's, while one
 * fixed profile would keep every session but the first from starting, since Chrome locks it.
 */
const BROWSER_ENV = {
  AGENT_BROWSER_ARGS: "--no-sandbox",
  AGENT_BROWSER_NAMESPACE: BROWSER_NAMESPACE,
};

/**
 * Every session an employee runs, a task or a one-shot, starts sealed: sandbox-exec cannot apply
 * a profile inside another, so neither CLI may sandbox its own commands in there. claude's
 * sandbox stays off and codex runs in external-sandbox mode (both in the registry), or every
 * command they run fails.
 */
export const acpAgentFor = (runner: AgentRunner, seal: Seal): AcpAgent => {
  const adapter: RunnerAdapter = RUNNERS[runner];
  const env: AcpAgent["env"] = {
    ...runnerEnv(runner),
    ...BROWSER_ENV,
    // The packaged executable is Electron; child agents need its Node mode.
    ELECTRON_RUN_AS_NODE: "1",
  };
  if (adapter.binEnvVar) {
    env[adapter.binEnvVar] = runnerBin(runner);
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
    const env = { ...runnerEnv(runner), ...BROWSER_ENV };
    const { stdout } = await execFileAsync(bin, rest, { env, timeout: 8000 });
    return stdout;
  };

const SessionInfo = z.object({ data: z.object({ active: z.boolean() }) });

const LivePageOutput = z.object({ data: z.object({ result: z.array(z.string().nullable()) }) });

/** The page `session` shows, read through `browser`; null when nothing could say. */
const readPage = async (browser: BrowserCli, session: string): ReturnType<LivePage> => {
  const scope = [
    "--namespace",
    BROWSER_NAMESPACE,
    ...(session === "" ? [] : ["--session", session]),
  ];
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
  (browser: BrowserCli): LivePage =>
  (session) =>
    readPage(browser, session);

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
// a run installs never lands in a store the founder's own projects link from.
const TOOL_CACHE_DIR = path.join(ROOT_DIR, "cache");

const TOOL_CACHE_ENV = {
  XDG_CACHE_HOME: TOOL_CACHE_DIR,
  npm_config_cache: path.join(TOOL_CACHE_DIR, "npm"),
  pnpm_config_store_dir: path.join(TOOL_CACHE_DIR, "pnpm-store"),
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
  raise: (ask: BlockedAsk) => void;
  current: () => BlockedAsk | null;
}

export const askBox = (onFirst: (ask: BlockedAsk) => void): AskBox => {
  let first: BlockedAsk | null = null;
  return {
    current: () => first,
    raise: (ask) => {
      if (first === null) {
        first = ask;
        onFirst(ask);
      }
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
  session: string | null;
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
): Memory => {
  if (turn.end.kind === "failed" && turn.end.sessionSpent) {
    return { instructionsDigest: null, session: null };
  }
  return turn.sessionId === undefined
    ? stored
    : { instructionsDigest: digest, session: turn.sessionId };
};

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

  constructor(checkSeal: () => Promise<SealState>) {
    this.checkSeal = checkSeal;
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

  private async probe(): Promise<RunnerProbe[]> {
    const probes = await probeRunners(runnerEnv);
    this.probes = probes;
    return probes;
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

  private async seal(): Promise<Seal> {
    const state = await this.sealing;
    if (state.kind === "refused") {
      throw new RefusalError(state.reason);
    }
    return state.seal;
  }

  async hasAnyRunner(): Promise<boolean> {
    await this.probing;
    return this.availableRunners().length > 0;
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
      agent: acpAgentFor(runner, await this.seal()),
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
    const resumeId = emp.sessionId ?? undefined;
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
      const stored = { instructionsDigest: emp.instructionsDigest, session: emp.sessionId };
      return { ...first.result, ...memoryAfter(first.turn, stored, digest) };
    }
    const retry = await this.invoke(emp, company, run, onEvent, tools, undefined, signal);
    // the stale attempt was still billed; each attempt is already priced, so add, don't re-price
    return {
      ...retry.result,
      ...memoryAfter(retry.turn, { instructionsDigest: digest, session: null }, digest),
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
    const seal = await this.seal();
    const livePage = livePageOf(sealedBrowser(seal, emp.runner));
    const handle = controlPlane.registerRun(tools.call);
    const leases = new Set<string>();
    let sawOutput = false;
    try {
      // the product's workspace is the cwd; the company workspace stays reachable
      // for what is shared across products
      const shared = run.workspace === company.workspaceDir ? [] : [company.workspaceDir];
      const memory = employeeMemoryDir(company.id, emp.id);
      mkdirSync(memory, { recursive: true });
      const addDirs = [...shared, memory, TOOL_CACHE_DIR];
      const confinement = {
        cwd: run.workspace,
        save: ROOT_DIR,
        writable: [run.workspace, ...addDirs],
      };
      const res = await runAcpTurn({
        addDirs,
        agent: acpAgentFor(emp.runner, seal),
        cwd: run.workspace,
        env: { ...handle.env, ...TOOL_CACHE_ENV },
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

/** A driver whose runs start only once `checkSeal` finds the seal holding: tests script the check, the app runs it. */
export const createAgentDriver = (checkSeal: () => Promise<SealState> = sealRuns): AgentDriver =>
  new AgentDriver(checkSeal);

export const agentDriver = createAgentDriver();
