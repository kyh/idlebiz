import { runClaude } from "./claude";
import { runCodex } from "./codex";
import type { RunnerId, RunnerOptions, RunnerResult } from "./runner";

/**
 * The one place the runner axis lives. Every runner is an ACP agent now, so
 * adding one is an entry here plus a few lines of adapter config; everything
 * else — dispatch, display names, login commands, pricing anchors — reads this
 * record.
 */
export interface RunnerAdapter {
  run(opts: RunnerOptions): Promise<RunnerResult>;
  displayName: string;
  /** Subcommand that starts the CLI's own interactive login. */
  loginArgs: string[];
  /** Pricing anchor when a run on the CLI's default model reports $0. */
  fallbackPricingModel: string;
}

export const RUNNERS = {
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
} satisfies Record<RunnerId, RunnerAdapter>;
