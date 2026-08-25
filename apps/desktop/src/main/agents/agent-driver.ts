import { probeRunners, type RunnerProbe } from "@repo/agent-driver/detect";
import { priceUsage } from "@repo/agent-driver/pricing";
import { parseRateLimit } from "@repo/agent-driver/rate-limit";
import { RUNNERS, type RunnerAdapter } from "@repo/agent-driver/registry";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_SESSION_MS } from "@repo/agent-driver/runner";
import { runAcpTurn, type AcpAgentSpec } from "@repo/agent-driver/acp-session";
import type { AgentEvent, AgentUsage } from "@repo/agent-driver/events";
import type { PermissionDecision, PermissionRequest } from "@repo/agent-driver/runner";
import { join } from "node:path";
import { createRequire } from "node:module";
import { controlPlane, type RunToolHooks } from "@/main/control-plane";
import * as store from "@/main/store/store";
import { ROOT_DIR, companyWorkspace, employeeAgentDir } from "@/main/paths";
import { approvalKey, classifyCommand, normalizeCommand } from "@/shared/domain";
import type { AgentRunner, BlockedAsk, Company, Employee } from "@/shared/domain";

/**
 * Where to find a runner's ACP agent, and how to make it ask.
 *
 * Resolution lives here rather than in the driver package because the agents
 * are spawned binaries, not imports: the app is what ships them, so the app is
 * what knows where they landed. `import.meta.url` is the bundled main process,
 * which resolves against the desktop app's own node_modules.
 */
export function acpSpecFor(runner: AgentRunner): AcpAgentSpec {
  const adapter: RunnerAdapter = RUNNERS[runner];
  const require = createRequire(import.meta.url);
  return {
    command: [process.execPath, require.resolve(`${adapter.acpPackage}/dist/index.js`)],
    sessionModeId: adapter.sessionModeId,
  };
}

/**
 * The founder-approval gate, now a plain function call.
 *
 * Every runner speaks ACP, so a tool call arrives here in-process instead of
 * through a spawned hook and a loopback request. Work that stays inside the
 * workspace is the employee's own business; only what reaches past it — a
 * deploy, a push, a payment — needs the founder, and a sign-off is spent
 * rather than merely checked, because the card promises one command once.
 */
async function decidePermission(
  companyId: string,
  request: PermissionRequest,
  block: (ask: BlockedAsk) => void,
): Promise<PermissionDecision> {
  const command = normalizeCommand(request.command);
  if (!command) return { allow: true };
  if (classifyCommand(command).decision === "allow") return { allow: true };
  if (store.consumeApproval(companyId, approvalKey(command))) return { allow: true };
  block({ type: "approval", command });
  return { allow: false };
}

/**
 * What a run cost in USD. Claude reports real dollars; codex reports only
 * tokens, and any run that ended without a terminal event reports whatever
 * the stream accounted for — both get priced from the runner's own rate table
 * rather than the generic fallback, so the live cap estimate and the recorded
 * spend can never disagree about the rate.
 */
export function priceRun(emp: Employee, usage: AgentUsage): number {
  if (usage.costUsd > 0) return usage.costUsd;
  if (usage.inputTokens + usage.outputTokens === 0) return 0;
  // Priced by the runner's anchor, not emp.model: ACP gives no way to pick a
  // model per session yet, so billing a model that never ran would be fiction.
  return priceUsage(RUNNERS[emp.runner].fallbackPricingModel, usage);
}

/**
 * Tool caches, kept out of the agent's own working tree.
 *
 * Codex's workspace-write sandbox denies `~/.npm`, which fails every `npx` —
 * including the `npx vercel deploy` agents are told to ship with. Putting the
 * cache *inside* the workspace fixes that but buries hundreds of MB of
 * tarballs where every `grep -r` and `git add` the agent runs will walk it, so
 * it lives beside the companies instead and is granted as a writable root.
 */
export const TOOL_CACHE_DIR = join(ROOT_DIR, "cache");

function toolCacheEnv() {
  return { npm_config_cache: join(TOOL_CACHE_DIR, "npm"), XDG_CACHE_HOME: TOOL_CACHE_DIR };
}

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
  /** The CLI hit its usage/session limit; park work until this epoch instead of retrying. */
  rateLimitedUntil?: number;
}

export type { RunToolHooks };

class AgentDriver {
  // CLI probes run async in the background; `probes` holds the latest results
  // and `probing` is awaited by anything that needs a definitive answer.
  private probes: RunnerProbe[] = [];
  private probing: Promise<RunnerProbe[]> = Promise.resolve([]);
  private active = new Map<string, AbortController>(); // employeeId -> abort
  private restingUntil = new Map<AgentRunner, number>(); // runner -> epoch its limit lifts

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

  /** Mixed-roster assignment: round-robin across whatever is available (awake first). */
  pickRunner(index: number): AgentRunner {
    const available = this.availableRunners();
    const awake = available.filter((r) => this.restingRunner(r) === null);
    const pool = awake.length > 0 ? awake : available;
    const pick = pool[index % Math.max(1, pool.length)];
    return pick ?? "codex";
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
      // A usage/session limit is a wall, not a flake — park the runner and
      // hand the reset time up; never burn the fresh-session retry on it.
      const limit = parseRateLimit(first.result.error);
      if (!first.result.ok && limit) {
        this.restingUntil.set(emp.runner, limit.resetsAt);
        return { ...first.result, rateLimitedUntil: limit.resetsAt };
      }
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
        const retryLimit = parseRateLimit(retry.result.error);
        if (!retry.result.ok && retryLimit) {
          this.restingUntil.set(emp.runner, retryLimit.resetsAt);
          return { ...retry.result, rateLimitedUntil: retryLimit.resetsAt };
        }
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
    try {
      const res = await runAcpTurn(
        {
          prompt,
          systemPrompt: store.employeeInstructions(emp.id),
          cwd: companyWorkspace(company.id),
          resumeSessionId,
          addDirs: [employeeAgentDir(company.id, emp.id), TOOL_CACHE_DIR],
          env: { ...handle.env, ...toolCacheEnv() },
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
        },
        acpSpecFor(emp.runner),
      );
      const usage = { ...res.usage, costUsd: priceRun(emp, res.usage) };
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
