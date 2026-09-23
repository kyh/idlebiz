import type { NewSessionRequest } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { Rates } from "./pricing";
import type { RunnerId } from "./runner";

export interface RunnerAdapter {
  /** Module specifier of the ACP subprocess. */
  acpEntry: string;
  /**
   * Mode that raises permission requests, set every turn: fresh or resumed, a session
   * starts in a default that may skip the founder gate — codex's own, or the
   * `permissions.defaultMode` claude reads from the player's user, project or local settings.
   */
  sessionModeId: string;
  /** Sent as `_meta` on session/new and session/resume: the adapter's own session options. */
  sessionMeta?: NewSessionRequest["_meta"];
  /** Adapter env var pointing at the player's CLI; bundled optional binaries may be absent. */
  binEnvVar?: string;
  /** The player's CLI on PATH, and the env var that overrides where it lives. */
  cli: { command: string; override: string };
  displayName: string;
  loginArgs: string[];
  authProbe: { args: string[]; loggedIn: (output: string) => boolean };
  /** What the CLI's default model costs, for pricing a run that reports $0. */
  fallbackRates: Rates;
  /**
   * The prompt response's usage covers only the turn's last model request, and one
   * usage_update arrives per request (codex-acp), so the turn is counted from their sum.
   */
  usagePerRequest?: true;
}

const claudeAuthStatus = z.object({ loggedIn: z.boolean() });

/** `claude auth status` prints JSON with a loggedIn flag, after whatever else it says. */
const claudeLoggedIn = (output: string): boolean => {
  const start = output.indexOf("{");
  if (start === -1) {
    return false;
  }
  try {
    const parsed = claudeAuthStatus.safeParse(
      JSON.parse(output.slice(start, output.lastIndexOf("}") + 1)),
    );
    return parsed.success && parsed.data.loggedIn;
  } catch {
    return false;
  }
};

/**
 * With bypass off, no settings tier can start a session in it. `settings` is the flag tier:
 * its ask rules beat allow rules from any tier, and its values outrank the player's user,
 * project and local settings, which stay loaded for their MCP servers.
 */
const claudeSessionMeta = {
  claudeCode: {
    options: {
      allowDangerouslySkipPermissions: false,
      settings: {
        permissions: { ask: ["Bash", "Edit", "Write", "NotebookEdit", "mcp__*"] },
        // a sandboxed command otherwise runs without the Bash ask
        sandbox: { autoAllowBashIfSandboxed: false },
      },
    },
  },
};

export const RUNNERS = {
  claude: {
    acpEntry: "@agentclientprotocol/claude-agent-acp/dist/index.js",
    authProbe: { args: ["auth", "status"], loggedIn: claudeLoggedIn },
    binEnvVar: "CLAUDE_CODE_EXECUTABLE",
    cli: { command: "claude", override: "CLAUDE_BIN" },
    displayName: "Claude Code",
    fallbackRates: { cachedInput: 0.3, input: 3, output: 15 },
    loginArgs: ["auth", "login"],
    sessionMeta: claudeSessionMeta,
    sessionModeId: "default",
  },
  codex: {
    acpEntry: "@agentclientprotocol/codex-acp/dist/index.js",
    // `codex login status` exits 0 either way and says how you're logged in
    authProbe: { args: ["login", "status"], loggedIn: (out) => !/not logged in/iu.test(out) },
    binEnvVar: "CODEX_PATH",
    cli: { command: "codex", override: "CODEX_BIN" },
    displayName: "Codex",
    fallbackRates: { cachedInput: 0.125, input: 1.25, output: 10 },
    loginArgs: ["login"],
    sessionModeId: "read-only",
    usagePerRequest: true,
  },
} satisfies Record<RunnerId, RunnerAdapter>;
