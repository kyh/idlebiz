// Keep this module free of Node dependencies: the renderer imports these ids.
export const RUNNER_IDS = ["claude", "codex"] as const;
export type RunnerId = (typeof RUNNER_IDS)[number];

export const isRunnerId = (v: string): v is RunnerId => RUNNER_IDS.some((id) => id === v);

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_SESSION_MS = 45 * 60_000;
