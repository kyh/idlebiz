import type { AgentEvent, AgentUsage } from "./events";

/**
 * Which coding-agent CLI executes a run. Both runners share one contract:
 * spawn a headless CLI session (fresh or resumed), stream normalized
 * AgentEvents while it works, and resolve a RunnerResult when it ends.
 * Continuity lives in the CLI's own session store — resume by id.
 */
export type RunnerId = "claude" | "codex";

export const RUNNER_IDS: readonly RunnerId[] = ["claude", "codex"];

export const isRunnerId = (v: string): v is RunnerId =>
  (RUNNER_IDS as readonly string[]).includes(v);

/** Binary override hooks, mirroring the CLIs' own conventions. */
export const runnerBin = (id: RunnerId): string =>
  id === "claude" ? (process.env.CLAUDE_BIN ?? "claude") : (process.env.CODEX_BIN ?? "codex");

/** Watchdog defaults sized for game tasks (minutes, not factory-scale hours). */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_SESSION_MS = 45 * 60_000;

export interface RunnerOptions {
  /** The task / wake prompt (delivered on stdin). */
  prompt: string;
  /**
   * Durable agent instructions (the employee's AGENTS.md body). Injected on
   * fresh sessions only — resumed sessions already carry them, so resume
   * sends just the wake prompt (paperclip's cheap "wake delta" convention).
   * Claude gets it via --append-system-prompt; codex has no system channel,
   * so it's prepended to the prompt.
   */
  systemPrompt: string;
  /** Working directory — the company workspace where real work lands. */
  cwd: string;
  /** Path to the runner binary (see runnerBin). */
  bin: string;
  /** Model override; omit to use the CLI's own default. */
  model?: string;
  /** Resume this CLI session instead of starting fresh. */
  resumeSessionId?: string;
  /** Extra dirs the agent may read/write (e.g. its own agent package dir). */
  addDirs?: string[];
  /** Run-scoped env additions (control-plane URL + token, secrets). */
  env?: Record<string, string>;
  /** Per-session agentic turn ceiling (claude only; 0/omit = CLI default). */
  maxTurns?: number;
  /** Kill + fail after this long with NO output (wedged process). 0 disables. */
  idleTimeoutMs: number;
  /** Absolute ceiling on one session regardless of activity. 0 disables. */
  maxSessionMs: number;
  /** Aborts the underlying process. */
  signal?: AbortSignal;
  /** Receives normalized events as the session streams. */
  onEvent: (e: AgentEvent) => void;
}

export interface RunnerResult {
  ok: boolean;
  /** The session's final assistant text (the run summary). */
  summary: string;
  /** CLI session id — persist it to resume this employee's context later. */
  sessionId?: string;
  usage: AgentUsage;
  error?: string;
}
