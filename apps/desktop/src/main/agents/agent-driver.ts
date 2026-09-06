import { isReady, probeRunners, runnerBin, type RunnerProbe } from "@repo/agent-driver/detect";
import { priceUsage } from "@repo/agent-driver/pricing";
import { parseRateLimit } from "@repo/agent-driver/rate-limit";
import { RUNNERS, type RunnerAdapter } from "@repo/agent-driver/registry";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_SESSION_MS,
  RUNNER_IDS,
} from "@repo/agent-driver/runner";
import {
  runAcpTurn,
  type AcpAgent,
  type PermissionDecision,
  type AcpTurnResult,
  type PermissionRequest,
} from "@repo/agent-driver/acp-session";
import type { AgentEvent, AgentUsage } from "@repo/agent-driver/events";
import { join, sep } from "node:path";
import { createRequire } from "node:module";
import { controlPlane, type RunToolHooks } from "@/main/control-plane";
import type { RestingRunners } from "@/shared/ipc-registry";
import * as store from "@/main/store/store";
import { ROOT_DIR, employeeAgentDir } from "@/main/paths";
import { classifyCommand, normalizeCommand } from "@/shared/command-policy";
import type { AgentRunner, BlockedAsk, Company, Employee, RunOutcome } from "@/shared/domain";

// The desktop app ships the ACP binaries, so resolve them against its node_modules.
const resolveFromApp = createRequire(import.meta.url);

export function acpAgentFor(runner: AgentRunner): AcpAgent {
  const adapter: RunnerAdapter = RUNNERS[runner];
  // The packaged executable is Electron; child agents need its Node mode.
  const env: AcpAgent["env"] = { ELECTRON_RUN_AS_NODE: "1" };
  if (adapter.binEnvVar) env[adapter.binEnvVar] = runnerBin(runner);
  return {
    command: [process.execPath, unpacked(resolveFromApp.resolve(adapter.acpEntry))],
    sessionModeId: adapter.sessionModeId,
    env,
  };
}

// Child processes cannot execute files inside asar; matches electron-builder's asarUnpack.
function unpacked(path: string): string {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}

function acpAgentInstalled(runner: AgentRunner): boolean {
  try {
    resolveFromApp.resolve(RUNNERS[runner].acpEntry);
    return true;
  } catch {
    return false;
  }
}

/** An approval permits one execution of the exact command. */
async function decidePermission(
  companyId: string,
  request: PermissionRequest,
  block: (ask: BlockedAsk) => void,
): Promise<PermissionDecision> {
  const command = normalizeCommand(request.command);
  if (!command) return { allow: true };
  const verdict = classifyCommand(command);
  if (verdict.decision === "allow") return { allow: true };
  if (store.consumeApproval(companyId, command)) return { allow: true };
  block({ type: "approval", command, rule: verdict.rule.id });
  return { allow: false };
}

/** Prefer reported dollars; otherwise price tokens at the runner's default model. */
function priceRun(emp: Employee, usage: AgentUsage): number {
  if (usage.costUsd > 0) return usage.costUsd;
  if (usage.inputTokens + usage.outputTokens === 0) return 0;
  return priceUsage(RUNNERS[emp.runner].fallbackPricingModel, usage);
}

// Codex cannot write ~/.npm. Grant a shared cache outside the agents' working trees.
const TOOL_CACHE_DIR = join(ROOT_DIR, "cache");

const TOOL_CACHE_ENV = {
  npm_config_cache: join(TOOL_CACHE_DIR, "npm"),
  XDG_CACHE_HOME: TOOL_CACHE_DIR,
};

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
  private active = new Map<string, AbortController>(); // employeeId -> abort
  private restingUntil = new Map<AgentRunner, number>(); // runner -> epoch its limit lifts

  init(): void {
    this.probing = probeRunners().then((probes) => {
      this.probes = probes;
      return probes;
    });
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
    if (runner === undefined) throw new Error("no signed-in coding CLI to run on");
    return runner;
  }

  restingRunners(): RestingRunners {
    const resting: RestingRunners = {};
    for (const runner of RUNNER_IDS) {
      const until = this.restingRunner(runner);
      if (until !== null) resting[runner] = until;
    }
    return resting;
  }

  /** Epoch until which this runner's usage limit holds, or null if it's awake. */
  restingRunner(runner: AgentRunner): number | null {
    const until = this.restingUntil.get(runner);
    if (until === undefined) return null;
    if (until <= Date.now()) {
      this.restingUntil.delete(runner);
      return null;
    }
    return until;
  }

  async runTask(
    emp: Employee,
    company: Company,
    task: { title: string; description: string; workspace: string },
    onEvent: (e: AgentEvent) => void,
    hooks: RunToolHooks,
  ): Promise<RunResult> {
    if (this.active.has(emp.id)) throw new Error(`employee ${emp.id} already running a task`);
    const abort = new AbortController();
    this.active.set(emp.id, abort);
    try {
      const prompt = `${task.title}\n\n${task.description}`.trim();
      const resumeId = emp.sessionId ?? undefined;
      const run = { prompt, workspace: task.workspace };
      const first = await this.invoke(emp, company, run, onEvent, hooks, resumeId, abort);
      // A resumed session that dies without producing any output is almost
      // always stale on the agent's side — retry once fresh before failing.
      const retryFresh =
        first.result.outcome.kind === "failed" && first.turn.resumed && !first.sawOutput;
      if (!retryFresh) {
        return { ...first.result, session: first.turn.sessionId ?? emp.sessionId };
      }
      const retry = await this.invoke(emp, company, run, onEvent, hooks, undefined, abort);
      return { ...retry.result, session: retry.turn.sessionId ?? null };
    } finally {
      this.active.delete(emp.id);
    }
  }

  /** A pending founder ask takes precedence over the runner's exit status. */
  private outcomeOf(runner: AgentRunner, turn: AcpTurnResult, ask: BlockedAsk | null): RunOutcome {
    if (ask) return { kind: "blocked", ask };
    if (turn.end.kind === "completed") return { kind: "done" };
    const limit = parseRateLimit(turn.end.error);
    if (!limit) return { kind: "failed", error: turn.end.error };
    this.restingUntil.set(runner, limit.resetsAt);
    return { kind: "resting", until: limit.resetsAt, error: turn.end.error };
  }

  private async invoke(
    emp: Employee,
    company: Company,
    run: { prompt: string; workspace: string },
    onEvent: (e: AgentEvent) => void,
    hooks: RunToolHooks,
    resumeSessionId: string | undefined,
    abort: AbortController,
  ): Promise<{
    result: Omit<RunResult, "session">;
    turn: AcpTurnResult;
    sawOutput: boolean;
  }> {
    const handle = controlPlane.registerRun(hooks);
    let sawOutput = false;
    try {
      // the product's workspace is the cwd; the company workspace stays reachable
      // for what is shared across products
      const shared = run.workspace === company.workspaceDir ? [] : [company.workspaceDir];
      const res = await runAcpTurn({
        agent: acpAgentFor(emp.runner),
        prompt: run.prompt,
        systemPrompt: store.employeeInstructions(emp.id),
        cwd: run.workspace,
        resumeSessionId,
        addDirs: [...shared, employeeAgentDir(company.id, emp.id), TOOL_CACHE_DIR],
        env: { ...handle.env, ...TOOL_CACHE_ENV },
        onPermission: (request) => decidePermission(company.id, request, handle.block),
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
        maxSessionMs: DEFAULT_MAX_SESSION_MS,
        signal: abort.signal,
        onEvent: (e) => {
          sawOutput = true;
          try {
            onEvent(e);
          } catch {
            /* a listener must never break the run */
          }
        },
      });
      const usage = { ...res.usage, costUsd: priceRun(emp, res.usage) };
      const outcome = this.outcomeOf(emp.runner, res, handle.outcome().blocked);
      return { result: { outcome, summary: res.summary, usage }, turn: res, sawOutput };
    } finally {
      handle.release();
    }
  }

  disposeEmployee(employeeId: string): void {
    this.active.get(employeeId)?.abort();
    this.active.delete(employeeId);
  }

  disposeAll(): void {
    for (const abort of this.active.values()) abort.abort();
    this.active.clear();
  }
}

export const agentDriver = new AgentDriver();
