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
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { parseJson } from "@/shared/json";
import { createRequire } from "node:module";
import { controlPlane } from "@/main/control-plane";
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
import { ROOT_DIR, employeeAgentDir } from "@/main/paths";
import { holdFor } from "@/shared/command-policy";
import type { LiveUrl } from "@/shared/command-policy";

// The desktop app ships the ACP binaries, so resolve them against its node_modules.
const resolveFromApp = createRequire(import.meta.url);

// Child processes cannot execute files inside asar; matches electron-builder's asarUnpack.
const unpacked = (file: string): string =>
  file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

const acpAgentFor = (runner: AgentRunner): AcpAgent => {
  const adapter: RunnerAdapter = RUNNERS[runner];
  // The packaged executable is Electron; child agents need its Node mode.
  const env: AcpAgent["env"] = { ELECTRON_RUN_AS_NODE: "1" };
  if (adapter.binEnvVar) {
    env[adapter.binEnvVar] = runnerBin(runner);
  }
  return {
    command: [process.execPath, unpacked(resolveFromApp.resolve(adapter.acpEntry))],
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

const LiveUrlOutput = z.object({ data: z.object({ url: z.string() }) });

/** Ask the browser itself: the session is the agent's, but any process of this user can read it. */
const liveBrowserUrl: LiveUrl = async (session) => {
  const scope = session === "" ? [] : ["--session", session];
  try {
    const { stdout } = await execFileAsync("agent-browser", [...scope, "get", "url", "--json"], {
      timeout: 8000,
    });
    const parsed = LiveUrlOutput.safeParse(parseJson(stdout));
    return parsed.success ? parsed.data.data.url : null;
  } catch {
    return null;
  }
};

/** An approval permits one execution of the exact command, or — for a site or a server — the rest of the run. */
export const decidePermission = async (
  task: { companyId: string; id: string },
  request: PermissionRequest,
  leases: Set<string>,
  hold: (ask: BlockedAsk) => void,
  signal: AbortSignal,
): Promise<PermissionDecision> => {
  const held = await holdFor(request.tool, leases, liveBrowserUrl);
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

// Codex cannot write ~/.npm. Grant a shared cache outside the agents' working trees.
const TOOL_CACHE_DIR = path.join(ROOT_DIR, "cache");

const TOOL_CACHE_ENV = {
  XDG_CACHE_HOME: TOOL_CACHE_DIR,
  npm_config_cache: path.join(TOOL_CACHE_DIR, "npm"),
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
  // runner -> epoch its limit lifts
  private restingUntil = new Map<AgentRunner, number>();

  init(): void {
    this.probing = this.probe();
  }

  private async probe(): Promise<RunnerProbe[]> {
    const probes = await probeRunners();
    this.probes = probes;
    return probes;
  }

  refresh(): Promise<RunnerProbe[]> {
    this.init();
    return this.probing;
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
      agent: acpAgentFor(runner),
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
    const handle = controlPlane.registerRun(tools.call);
    const leases = new Set<string>();
    let sawOutput = false;
    try {
      // the product's workspace is the cwd; the company workspace stays reachable
      // for what is shared across products
      const shared = run.workspace === company.workspaceDir ? [] : [company.workspaceDir];
      const res = await runAcpTurn({
        addDirs: [...shared, employeeAgentDir(company.id, emp.id), TOOL_CACHE_DIR],
        agent: acpAgentFor(emp.runner),
        cwd: run.workspace,
        env: { ...handle.env, ...TOOL_CACHE_ENV },
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
        instructionsChanged: run.instructionsChanged,
        maxSessionMs: DEFAULT_MAX_SESSION_MS,
        onEvent: (e) => {
          sawOutput = true;
          try {
            onEvent(e);
          } catch {
            /* a listener must never break the run */
          }
        },
        onPermission: (request, turnEnded) =>
          decidePermission(
            { companyId: company.id, id: run.taskId },
            request,
            leases,
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

export const agentDriver = new AgentDriver();
