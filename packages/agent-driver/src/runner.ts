/**
 * Which coding-agent CLI backs an employee.
 *
 * Identity only — the vocabulary of actually running a turn lives with the
 * code that runs it, in acp-session.ts. Keeping this module free of node
 * imports beyond env reads is what lets `RunnerId` be type-re-exported into
 * renderer-safe shared code.
 */
export const RUNNER_IDS = ["claude", "codex"] as const;
export type RunnerId = (typeof RUNNER_IDS)[number];

export const isRunnerId = (v: string): v is RunnerId => RUNNER_IDS.some((id) => id === v);

/**
 * The underlying CLI binary, with the same override hooks the CLIs use.
 *
 * We spawn ACP adapters rather than these directly, but the adapters run on
 * the CLI's own login — so this is still what gets probed to answer "can this
 * runner work at all".
 */
export const runnerBin = (id: RunnerId): string =>
  id === "claude" ? (process.env.CLAUDE_BIN ?? "claude") : (process.env.CODEX_BIN ?? "codex");

/** Watchdog defaults sized for game tasks (minutes, not factory-scale hours). */
export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_SESSION_MS = 45 * 60_000;
