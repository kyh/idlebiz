import { runClaude } from "./claude";
import { runCodex } from "./codex";
import type { RunnerId, RunnerOptions, RunnerResult } from "./runner";

/**
 * The one place the runner axis lives. Adding a CLI = one entry here (plus
 * its adapter file); everything else — dispatch, display names, login
 * commands, pricing anchors — reads this record.
 */
export interface RunnerAdapter {
  run(opts: RunnerOptions): Promise<RunnerResult>;
  displayName: string;
  /** Subcommand that starts the CLI's own interactive login. */
  loginArgs: string[];
  /** Pricing anchor when a run on the CLI's default model reports $0. */
  fallbackPricingModel: string;
}

export const RUNNERS: Record<RunnerId, RunnerAdapter> = {
  claude: {
    run: runClaude,
    displayName: "Claude Code",
    loginArgs: ["auth", "login"],
    fallbackPricingModel: "claude-sonnet",
  },
  codex: {
    run: runCodex,
    displayName: "Codex",
    loginArgs: ["login"],
    fallbackPricingModel: "gpt-5.5-codex",
  },
};
