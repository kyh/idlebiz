import { runClaude } from "@repo/agent-driver/claude";
import { runCodex } from "@repo/agent-driver/codex";
import { probeRunners, type RunnerProbe } from "@repo/agent-driver/detect";
import { priceUsage } from "@repo/agent-driver/pricing";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_SESSION_MS,
  runnerBin,
} from "@repo/agent-driver/runner";
import type { AgentEvent, AgentUsage } from "@repo/agent-driver/events";
import { controlPlane, type RunToolHooks } from "@/main/control-plane";
import * as store from "@/main/store/store";
import { companyWorkspace, employeeAgentDir } from "@/main/paths";
import type { AgentRunner, Company, Employee } from "@/shared/domain";

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
  blockedQuestion?: string;
  /** The stored session id failed to resume — the caller should clear it. */
  staleSession?: boolean;
}

export type { RunToolHooks };

/** Rough pricing anchors for runs on the CLI's default model. */
const FALLBACK_PRICING_MODEL: Record<AgentRunner, string> = {
  claude: "claude-sonnet",
  codex: "gpt-5.5-codex",
};

class AgentDriver {
  private probes: RunnerProbe[] = [];
  private active = new Map<string, AbortController>(); // employeeId -> abort

  /** Probe installed CLIs once at boot (re-run after installs). */
  init(): void {
    this.probes = probeRunners();
  }

  refresh(): RunnerProbe[] {
    this.init();
    return this.probes;
  }

  runnerStatus(): RunnerProbe[] {
    return [...this.probes];
  }

  /** Runners that can actually execute work right now. */
  availableRunners(): AgentRunner[] {
    return this.probes.filter((p) => p.installed && p.authed).map((p) => p.id);
  }

  hasAnyRunner(): boolean {
    return this.availableRunners().length > 0;
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
      employeeName: emp.name,
      companyId: company.id,
      taskId: task.id,
      hooks,
    });
    let sawOutput = false;
    const run = emp.runner === "claude" ? runClaude : runCodex;
    try {
      const res = await run({
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
          if (e.type === "message_end" || e.type === "tool_start") sawOutput = true;
          try {
            onEvent(e);
          } catch {
            /* a listener must never break the run */
          }
        },
      });
      const usage = { ...res.usage };
      if (usage.costUsd === 0 && usage.inputTokens + usage.outputTokens > 0) {
        usage.costUsd = priceUsage(emp.model ?? FALLBACK_PRICING_MODEL[emp.runner], usage);
      }
      const { blockedQuestion } = handle.outcome();
      return {
        result: {
          ok: res.ok,
          error: res.error,
          summary: res.summary,
          usage,
          sessionId: res.sessionId,
          blockedQuestion: blockedQuestion ?? undefined,
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
