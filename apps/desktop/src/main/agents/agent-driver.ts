import { isReady, probeRunners, type RunnerProbe } from "@repo/agent-driver/detect";
import { priceUsage } from "@repo/agent-driver/pricing";
import { parseRateLimit } from "@repo/agent-driver/rate-limit";
import { RUNNERS, type RunnerAdapter } from "@repo/agent-driver/registry";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_SESSION_MS,
  runnerBin,
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
import * as store from "@/main/store/store";
import { ROOT_DIR, companyWorkspace, employeeAgentDir } from "@/main/paths";
import { classifyCommand, normalizeCommand } from "@/shared/command-policy";
import type { AgentRunner, BlockedAsk, Company, Employee, RunOutcome } from "@/shared/domain";

/**
 * Where to find a runner's ACP agent, and how to make it ask.
 *
 * Resolution lives here rather than in the driver package because the agents
 * are spawned binaries, not imports: the app is what ships them, so the app is
 * what knows where they landed. `import.meta.url` is the bundled main process,
 * which resolves against the desktop app's own node_modules.
 */
const resolveFromApp = createRequire(import.meta.url);

export function acpAgentFor(runner: AgentRunner): AcpAgent {
  const adapter: RunnerAdapter = RUNNERS[runner];
  // In a packaged app `process.execPath` is the Electron binary, which would
  // otherwise treat the agent's entry file as a new Electron app instead of
  // running it as node.
  const env: AcpAgent["env"] = { ELECTRON_RUN_AS_NODE: "1" };
  if (adapter.binEnvVar) env[adapter.binEnvVar] = runnerBin(runner);
  return {
    command: [process.execPath, unpacked(resolveFromApp.resolve(adapter.acpEntry))],
    sessionModeId: adapter.sessionModeId,
    env,
  };
}

/**
 * Point at the real file, not the one inside the archive.
 *
 * Electron reads transparently through `app.asar`, so resolution succeeds and
 * everything looks fine — but a child process cannot execute a script that
 * exists only inside the archive, and the failure is silent: the agent spawns
 * and answers nothing. electron-builder puts these packages in
 * `app.asar.unpacked` (see asarUnpack); this is the matching half.
 */
function unpacked(path: string): string {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}

/** Is this runner's ACP agent actually installed? */
function acpAgentInstalled(runner: AgentRunner): boolean {
  try {
    resolveFromApp.resolve(RUNNERS[runner].acpEntry);
    return true;
  } catch {
    return false;
  }
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
  if (store.consumeApproval(companyId, command)) return { allow: true };
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
const TOOL_CACHE_DIR = join(ROOT_DIR, "cache");

const TOOL_CACHE_ENV = {
  npm_config_cache: join(TOOL_CACHE_DIR, "npm"),
  XDG_CACHE_HOME: TOOL_CACHE_DIR,
};

// ---------------------------------------------------------------------------
// The employee runtime: each run spawns the employee's ACP agent, resume-first
// (the agent's session store is the employee's working memory), with the game's
// control-plane API reachable through run-scoped env.
// ---------------------------------------------------------------------------

export interface RunResult {
  outcome: RunOutcome;
  /** The agent's final message. */
  summary: string;
  /** The session to remember for this employee after the run; null forgets it. */
  session: string | null;
  usage: AgentUsage;
}

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
    // The probe answers for the CLI's login, which the ACP adapter rides on.
    // The adapter itself is a separate thing that can be missing from a build,
    // and a runner whose agent won't resolve should read as unavailable at
    // boot rather than throwing mid-run.
    return this.probes.filter((p) => isReady(p) && acpAgentInstalled(p.id)).map((p) => p.id);
  }

  /**
   * Mixed-roster assignment: round-robin across whatever is available (awake
   * first). Throws when nothing is: an employee bound to a CLI that is not
   * signed in would sit forever, and every hire path can say so instead.
   */
  pickRunner(index: number): AgentRunner {
    const available = this.availableRunners();
    const awake = available.filter((r) => this.restingRunner(r) === null);
    const pool = awake.length > 0 ? awake : available;
    const runner = pool[index % pool.length];
    if (runner === undefined) throw new Error("no signed-in coding CLI to run on");
    return runner;
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
    task: { title: string; description: string | null },
    onEvent: (e: AgentEvent) => void,
    hooks: RunToolHooks,
  ): Promise<RunResult> {
    if (this.active.has(emp.id)) throw new Error(`employee ${emp.id} already running a task`);
    const abort = new AbortController();
    this.active.set(emp.id, abort);
    try {
      const prompt = `${task.title}\n\n${task.description ?? ""}`.trim();
      const resumeId = emp.sessionId ?? undefined;
      const first = await this.invoke(emp, company, prompt, onEvent, hooks, resumeId, abort);
      // A resumed session that dies without producing any output is almost
      // always stale on the agent's side — retry once fresh before failing.
      const retryFresh =
        first.result.outcome.kind === "failed" && first.turn.resumed && !first.sawOutput;
      if (!retryFresh) {
        return { ...first.result, session: first.turn.sessionId ?? emp.sessionId };
      }
      const retry = await this.invoke(emp, company, prompt, onEvent, hooks, undefined, abort);
      return { ...retry.result, session: retry.turn.sessionId ?? null };
    } finally {
      this.active.delete(emp.id);
    }
  }

  /**
   * How the turn ended, as the scheduler settles it. A pending ask wins over
   * everything (the agent stopped to wait for the founder); a usage limit is a
   * wall, not a flake — the runner is parked so nothing retries into it.
   */
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
    prompt: string,
    onEvent: (e: AgentEvent) => void,
    hooks: RunToolHooks,
    resumeSessionId: string | undefined,
    abort: AbortController,
  ): Promise<{ result: Omit<RunResult, "session">; turn: AcpTurnResult; sawOutput: boolean }> {
    const handle = controlPlane.registerRun({ hooks });
    let sawOutput = false;
    try {
      const res = await runAcpTurn({
        agent: acpAgentFor(emp.runner),
        prompt,
        systemPrompt: store.employeeInstructions(emp.id),
        cwd: companyWorkspace(company.id),
        resumeSessionId,
        addDirs: [employeeAgentDir(company.id, emp.id), TOOL_CACHE_DIR],
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
