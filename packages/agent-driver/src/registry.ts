import { z } from "zod";
import type { RunnerId } from "./runner";

/**
 * The one place the runner axis lives. Every runner is an ACP agent, so an
 * entry here is the whole definition — there is no per-runner code left.
 * Everything else (dispatch, display names, login commands, pricing anchors)
 * reads this record.
 */
export interface RunnerAdapter {
  /**
   * Module specifier of this runner's ACP agent, spawned as a subprocess.
   * The whole specifier lives here so no other file has to know a third-party
   * package's internal layout.
   */
  acpEntry: string;
  /**
   * Session mode that makes this agent ask before it acts, where it needs one.
   *
   * Load-bearing for the founder gate: codex defaults to a mode that runs
   * commands without raising a permission request, so leaving this unset would
   * silently disable approvals for every codex employee. Claude's default
   * already asks.
   */
  sessionModeId?: string;
  /**
   * Env var this runner's ACP agent uses to find the CLI binary.
   *
   * Both adapters ship a native CLI as an *optional* dependency and exec it.
   * Optional deps do not survive packaging, so a built app fails with "native
   * binary not found" while dev works fine. Pointing each adapter at the
   * player's own install fixes that, keeps the "runs on your signed-in CLI"
   * promise, and keeps a second copy of each CLI out of the build.
   */
  binEnvVar?: string;
  displayName: string;
  /** Subcommand that starts the CLI's own interactive login. */
  loginArgs: string[];
  /** Subcommand that reports whether the CLI is signed in, and how to read its answer. */
  authProbe: { args: string[]; loggedIn: (output: string) => boolean };
  /** Pricing anchor when a run on the CLI's default model reports $0. */
  fallbackPricingModel: string;
}

const claudeAuthStatus = z.object({ loggedIn: z.boolean() });

/** `claude auth status` prints JSON with a loggedIn flag, after whatever else it says. */
function claudeLoggedIn(output: string): boolean {
  const start = output.indexOf("{");
  if (start < 0) return false;
  try {
    const parsed = claudeAuthStatus.safeParse(
      JSON.parse(output.slice(start, output.lastIndexOf("}") + 1)),
    );
    return parsed.success && parsed.data.loggedIn;
  } catch {
    return false;
  }
}

export const RUNNERS = {
  claude: {
    acpEntry: "@agentclientprotocol/claude-agent-acp/dist/index.js",
    binEnvVar: "CLAUDE_CODE_EXECUTABLE",
    displayName: "Claude Code",
    loginArgs: ["auth", "login"],
    authProbe: { args: ["auth", "status"], loggedIn: claudeLoggedIn },
    fallbackPricingModel: "claude-sonnet",
  },
  codex: {
    acpEntry: "@agentclientprotocol/codex-acp/dist/index.js",
    sessionModeId: "read-only",
    binEnvVar: "CODEX_PATH",
    displayName: "Codex",
    loginArgs: ["login"],
    // `codex login status` exits 0 either way and says how you're logged in
    authProbe: { args: ["login", "status"], loggedIn: (out) => !/not logged in/i.test(out) },
    fallbackPricingModel: "gpt-5.5-codex",
  },
} satisfies Record<RunnerId, RunnerAdapter>;
