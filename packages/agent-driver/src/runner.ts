/**
 * Which coding-agent CLI backs an employee.
 *
 * Identity only — the vocabulary of actually running a turn lives with the
 * code that runs it, in acp-session.ts. This module touches nothing of
 * Node's, not even process.env, which is what lets renderer-safe shared code
 * import it.
 */
export const RUNNER_IDS = ["claude", "codex"] as const;
export type RunnerId = (typeof RUNNER_IDS)[number];

export const isRunnerId = (v: string): v is RunnerId => RUNNER_IDS.some((id) => id === v);

/** Watchdog defaults sized for game tasks (minutes, not factory-scale hours). */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_SESSION_MS = 45 * 60_000;
