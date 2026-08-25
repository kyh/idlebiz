import type { RunnerId } from "./runner";

/**
 * The one place the runner axis lives. Every runner is an ACP agent, so an
 * entry here is the whole definition — there is no per-runner code left.
 * Everything else (dispatch, display names, login commands, pricing anchors)
 * reads this record.
 */
export interface RunnerAdapter {
  /** npm package providing this runner's ACP agent, spawned as a subprocess. */
  acpPackage: string;
  /**
   * Session mode that makes this agent ask before it acts, where it needs one.
   *
   * Load-bearing for the founder gate: codex defaults to a mode that runs
   * commands without raising a permission request, so leaving this unset would
   * silently disable approvals for every codex employee. Claude's default
   * already asks.
   */
  sessionModeId?: string;
  displayName: string;
  /** Subcommand that starts the CLI's own interactive login. */
  loginArgs: string[];
  /** Pricing anchor when a run on the CLI's default model reports $0. */
  fallbackPricingModel: string;
}

export const RUNNERS = {
  claude: {
    acpPackage: "@agentclientprotocol/claude-agent-acp",
    displayName: "Claude Code",
    loginArgs: ["auth", "login"],
    fallbackPricingModel: "claude-sonnet",
  },
  codex: {
    acpPackage: "@agentclientprotocol/codex-acp",
    sessionModeId: "read-only",
    displayName: "Codex",
    loginArgs: ["login"],
    fallbackPricingModel: "gpt-5.5-codex",
  },
} satisfies Record<RunnerId, RunnerAdapter>;
