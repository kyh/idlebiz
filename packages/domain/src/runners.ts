/** The coding-agent CLIs a run can drive, each signed in as the founder. */
export const RUNNER_IDS = ["claude", "codex"] as const;
export type RunnerId = (typeof RUNNER_IDS)[number];

/** Each runner as the founder knows it: the name of the CLI it signs in. */
export const RUNNER_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
} as const satisfies Record<RunnerId, string>;
