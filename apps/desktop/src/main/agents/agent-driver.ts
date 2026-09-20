import { isReady, probeRunners, runnerBin } from "@repo/agent-driver/detect";
import type { RunnerProbe } from "@repo/agent-driver/detect";
import { priceUsage } from "@repo/agent-driver/pricing";
import { parseRateLimit } from "@repo/agent-driver/rate-limit";
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
import type { AgentEvent, AgentUsage } from "@repo/agent-driver/events";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { parseJson } from "@/shared/json";
import { createRequire } from "node:module";
import { controlPlane } from "@/main/control-plane";
import type { ToolCaller } from "@/main/control-plane";
import type { AskBox } from "@/main/tools";
import type { RestingRunners } from "@/shared/ipc-registry";
import * as store from "@/main/store/store";
import { ROOT_DIR, employeeAgentDir } from "@/main/paths";
import { holdFor } from "@/shared/command-policy";
import type { LiveUrl } from "@/shared/command-policy";
import type { AgentRunner, BlockedAsk, Company, Employee, RunOutcome } from "@/shared/domain";

// The desktop app ships the ACP binaries, so resolve them against its node_modules.
const resolveFromApp = createRequire(import.meta.url);

// Child processes cannot execute files inside asar; matches electron-builder's asarUnpack.
const unpacked = (file: string): string =>
  file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

export const acpAgentFor = (runner: AgentRunner): AcpAgent => {
  const adapter: RunnerAdapter = RUNNERS[runner];
  // The packaged executable is Electron; child agents need its Node mode.
  const env: AcpAgent["env"] = { ELECTRON_RUN_AS_NODE: "1" };
  if (adapter.binEnvVar) {
    env[adapter.binEnvVar] = runnerBin(runner);
  }
  return {
    command: [process.execPath, unpacked(resolveFromApp.resolve(adapter.acpEntry))],
    env,
    sessionModeId: adapter.sessionModeId,
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
const decidePermission = async (
  task: { companyId: string; id: string },
  request: PermissionRequest,
  leases: Set<string>,
  hold: (ask: BlockedAsk) => void,
): Promise<PermissionDecision> => {
  const held = await holdFor(request.tool, leases, liveBrowserUrl);
  if (held === null) {
    return { allow: true };
  }
  if (store.consumeApproval(task.companyId, task.id, held.key)) {
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
  return priceUsage(RUNNERS[emp.runner].fallbackPricingModel, usage);
};

// Codex cannot write ~/.npm. Grant a shared cache outside the agents' working trees.
const TOOL_CACHE_DIR = path.join(ROOT_DIR, "cache");

const TOOL_CACHE_ENV = {
  XDG_CACHE_HOME: TOOL_CACHE_DIR,
  npm_config_cache: path.join(TOOL_CACHE_DIR, "npm"),
};

/** How a turn ended, as the scheduler settles it. An ask outranks everything: the founder's answer is what the task waits on. */
export const outcomeOf = (
  end: AcpTurnResult["end"],
  ask: BlockedAsk | null,
  restingUntil: number | null,
): RunOutcome => {
  if (ask) {
    return { ask, kind: "blocked" };
  }
  if (end.kind === "completed") {
    return { kind: "done" };
  }
  return restingUntil === null
    ? { error: end.error, kind: "failed" }
    : { error: end.error, kind: "resting", until: restingUntil };
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
  usage: AgentUsage;
}

class AgentDriver {
  // Boot probes in the background; callers needing a definitive answer await probing.
  private probes: RunnerProbe[] = [];
  private probing: Promise<RunnerProbe[]> = Promise.resolve([]);
  // employeeId -> abort
  private active = new Map<string, AbortController>();
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

  async runTask(
    emp: Employee,
    company: Company,
    task: { id: string; title: string; description: string; workspace: string },
    onEvent: (e: AgentEvent) => void,
    tools: RunTools,
  ): Promise<RunResult> {
    if (this.active.has(emp.id)) {
      throw new Error(`employee ${emp.id} already running a task`);
    }
    const abort = new AbortController();
    this.active.set(emp.id, abort);
    try {
      const prompt = `${task.title}\n\n${task.description}`.trim();
      const resumeId = emp.sessionId ?? undefined;
      const run = { prompt, taskId: task.id, workspace: task.workspace };
      const first = await this.invoke(emp, company, run, onEvent, tools, resumeId, abort);
      // A resumed session that dies without producing any output is almost
      // always stale on the agent's side — retry once fresh before failing.
      const retryFresh =
        first.result.outcome.kind === "failed" && first.turn.resumed && !first.sawOutput;
      if (!retryFresh) {
        return { ...first.result, session: first.turn.sessionId ?? emp.sessionId };
      }
      const retry = await this.invoke(emp, company, run, onEvent, tools, undefined, abort);
      return { ...retry.result, session: retry.turn.sessionId ?? null };
    } finally {
      this.active.delete(emp.id);
    }
  }

  /** A pending founder ask takes precedence over the runner's exit status. */

  private async invoke(
    emp: Employee,
    company: Company,
    run: { prompt: string; taskId: string; workspace: string },
    onEvent: (e: AgentEvent) => void,
    tools: RunTools,
    resumeSessionId: string | undefined,
    abort: AbortController,
  ): Promise<{
    result: Omit<RunResult, "session">;
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
        maxSessionMs: DEFAULT_MAX_SESSION_MS,
        onEvent: (e) => {
          sawOutput = true;
          try {
            onEvent(e);
          } catch {
            /* a listener must never break the run */
          }
        },
        onPermission: (request) =>
          decidePermission(
            { companyId: company.id, id: run.taskId },
            request,
            leases,
            tools.asks.raise,
          ),
        prompt: run.prompt,
        resumeSessionId,
        signal: abort.signal,
        systemPrompt: store.employeeInstructions(emp.id),
      });
      const usage = { ...res.usage, costUsd: priceRun(emp, res.usage) };
      const limit = res.end.kind === "failed" ? parseRateLimit(res.end.error) : null;
      // parked whatever else the run says: an ask raised before the limit hit must not hide it
      if (limit) {
        this.restingUntil.set(emp.runner, limit.resetsAt);
      }
      const outcome = outcomeOf(res.end, tools.asks.current(), limit?.resetsAt ?? null);
      return { result: { outcome, summary: res.summary, usage }, sawOutput, turn: res };
    } finally {
      handle.release();
    }
  }

  disposeEmployee(employeeId: string): void {
    this.active.get(employeeId)?.abort();
    this.active.delete(employeeId);
  }

  disposeAll(): void {
    for (const abort of this.active.values()) {
      abort.abort();
    }
    this.active.clear();
  }
}

export const agentDriver = new AgentDriver();
