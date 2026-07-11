import { probeRunners, type RunnerProbe } from "@repo/agent-driver/detect";
import { priceUsage } from "@repo/agent-driver/pricing";
import { RUNNERS } from "@repo/agent-driver/registry";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_SESSION_MS,
  runnerBin,
} from "@repo/agent-driver/runner";
import type { AgentEvent, AgentUsage } from "@repo/agent-driver/events";
import { controlPlane, type RunToolHooks } from "@/main/control-plane";
import * as store from "@/main/store/store";
import { companyWorkspace, employeeAgentDir } from "@/main/paths";
import type { AgentRunner, BlockedAsk, Company, Employee } from "@/shared/domain";

// ---------------------------------------------------------------------------
// The employee runtime: each run spawns the employee's CLI (claude / codex),
// resume-first (the CLI session store is the employee's working memory), with
// the game's control-plane API exposed via run-scoped env. Paperclip
// convention, minus the human gates.
// ---------------------------------------------------------------------------

export interface RunResult {
  ok: boolean;
  error?: string;
  summary: string;
  usage: AgentUsage;
  sessionId?: string;
  blocked?: BlockedAsk;
  /** The stored session id failed to resume — the caller should clear it. */
  staleSession?: boolean;
}

export type { RunToolHooks };

class AgentDriver {
  // CLI probes run async in the background; `probes` holds the latest results
  // and `probing` is awaited by anything that needs a definitive answer.
  private probes: RunnerProbe[] = [];
  private probing: Promise<RunnerProbe[]> = Promise.resolve([]);
  private active = new Map<string, AbortController>(); // employeeId -> abort

  /** Kick off CLI probes (never blocks — boot calls this before the window shows). */
  init(): void {
    this.probing = probeRunners().then((probes) => {
      this.probes = probes;
      return probes;
    });
  }

  /** Re-probe (after installs/logins) and wait for the fresh results. */
  refresh(): Promise<RunnerProbe[]> {
    this.init();
    return this.probing;
  }

  async hasAnyRunner(): Promise<boolean> {
    await this.probing;
    return this.availableRunners().length > 0;
  }

  /** Runners that can execute work, per the most recent probe. */
  availableRunners(): AgentRunner[] {
    return this.probes.filter((p) => p.installed && p.authed).map((p) => p.id);
  }

  /** Mixed-roster assignment: round-robin across whatever is available. */
  pickRunner(index: number): AgentRunner {
    const available = this.availableRunners();
    const pick = available[index % Math.max(1, available.length)];
    return pick ?? "codex";
  }

  async runTask(
    emp: Employee,
    company: Company,
    task: { id?: string; title: string; description: string | null },
    onEvent: (e: AgentEvent) => void,
    hooks: RunToolHooks,
  ): Promise<RunResult> {
    if (this.active.has(emp.id)) throw new Error(`employee ${emp.id} already running a task`);
    const abort = new AbortController();
    this.active.set(emp.id, abort);
    try {
      const prompt = `${task.title}\n\n${task.description ?? ""}`.trim();
      const resumeId = emp.sessionId ?? undefined;
      const first = await this.invoke(emp, company, task, prompt, onEvent, hooks, resumeId, abort);
      // A resume that dies without producing any output is almost always a
      // stale/unknown session — retry once with a fresh one before failing.
      if (!first.result.ok && !first.sawOutput && resumeId) {
        const retry = await this.invoke(
          emp,
          company,
          task,
          prompt,
          onEvent,
          hooks,
          undefined,
          abort,
        );
        return { ...retry.result, staleSession: retry.result.sessionId === undefined };
      }
      return first.result;
    } finally {
      this.active.delete(emp.id);
    }
  }

  private async invoke(
    emp: Employee,
    company: Company,
    task: { id?: string },
    prompt: string,
    onEvent: (e: AgentEvent) => void,
    hooks: RunToolHooks,
    resumeSessionId: string | undefined,
    abort: AbortController,
  ): Promise<{ result: RunResult; sawOutput: boolean }> {
    const handle = controlPlane.registerRun({
      employeeId: emp.id,
      companyId: company.id,
      taskId: task.id,
      hooks,
    });
    let sawOutput = false;
    const adapter = RUNNERS[emp.runner];
    try {
      const res = await adapter.run({
        prompt,
        systemPrompt: store.employeeInstructions(emp.id),
        cwd: companyWorkspace(company.id),
        bin: runnerBin(emp.runner),
        model: emp.model ?? undefined,
        resumeSessionId,
        addDirs: [employeeAgentDir(company.id, emp.id)],
        env: handle.env,
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
      const usage = { ...res.usage };
      if (usage.costUsd === 0 && usage.inputTokens + usage.outputTokens > 0) {
        usage.costUsd = priceUsage(emp.model ?? adapter.fallbackPricingModel, usage);
      }
      const { blocked } = handle.outcome();
      return {
        result: {
          ok: res.ok,
          error: res.error,
          summary: res.summary,
          usage,
          sessionId: res.sessionId,
          blocked: blocked ?? undefined,
        },
        sawOutput,
      };
    } finally {
      handle.release();
    }
  }

  /** Abort a live run (employee released, reset, quit). */
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
