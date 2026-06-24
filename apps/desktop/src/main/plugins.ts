// Lightweight plugin host (adapted from TinyAGI's message hooks + event
// listeners). Plugins observe the activity stream and hook the run lifecycle:
//   - onActivity:  an event listener fired for every activity event
//   - onRunStart:  a pre-run hook that may append extra instructions to a brief
//   - onRunEnd:    a post-run hook fired when a run settles
//
// Everything runs in-process inside the Electron main; a misbehaving plugin is
// isolated with try/catch so it can never break the scheduler.

import type { ActivityEvent, Company, Employee, Task } from "@/shared/domain";

export interface RunContext {
  company: Company;
  employee: Employee;
  task: Task;
}

export interface RunOutcome {
  ok: boolean;
  status: TaskOutcomeStatus;
  summary: string;
  error?: string;
}

type TaskOutcomeStatus = "done" | "blocked" | "queued" | "dead";

export interface IdleBizPlugin {
  name: string;
  /** Fired for every activity event (event listener). */
  onActivity?(e: ActivityEvent): void;
  /** Pre-run hook: return extra instructions to append to the agent's brief. */
  onRunStart?(ctx: RunContext): string | undefined;
  /** Post-run hook: react to how a run settled. */
  onRunEnd?(ctx: RunContext, outcome: RunOutcome): void;
}

class PluginHost {
  private plugins: IdleBizPlugin[] = [];

  register(plugin: IdleBizPlugin): void {
    this.plugins.push(plugin);
  }

  /** Notify every event listener (errors are swallowed per-plugin). */
  dispatchActivity(e: ActivityEvent): void {
    for (const p of this.plugins) {
      try {
        p.onActivity?.(e);
      } catch {
        /* a plugin must never break the activity stream */
      }
    }
  }

  /** Gather any extra brief instructions plugins want to inject before a run. */
  collectRunStart(ctx: RunContext): string {
    const extra: string[] = [];
    for (const p of this.plugins) {
      try {
        const out = p.onRunStart?.(ctx);
        if (out) extra.push(out);
      } catch {
        /* ignore a misbehaving pre-run hook */
      }
    }
    return extra.join("\n");
  }

  /** Notify post-run hooks that a run settled. */
  dispatchRunEnd(ctx: RunContext, outcome: RunOutcome): void {
    for (const p of this.plugins) {
      try {
        p.onRunEnd?.(ctx, outcome);
      } catch {
        /* ignore a misbehaving post-run hook */
      }
    }
  }
}

export const pluginHost = new PluginHost();
