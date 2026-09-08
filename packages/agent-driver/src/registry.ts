import { z } from "zod";
import type { RunnerId } from "./runner";

export interface RunnerAdapter {
  /** Module specifier of the ACP subprocess. */
  acpEntry: string;
  /** Mode that raises permission requests. Codex needs it; Claude asks by default. */
  sessionModeId?: string;
  /** Adapter env var pointing at the player's CLI; bundled optional binaries may be absent. */
  binEnvVar?: string;
  displayName: string;
  loginArgs: string[];
  authProbe: { args: string[]; loggedIn: (output: string) => boolean };
  /** Pricing anchor when a run on the CLI's default model reports $0. */
  fallbackPricingModel: string;
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

export const RUNNERS = {
  claude: {
    acpEntry: "@agentclientprotocol/claude-agent-acp/dist/index.js",
    authProbe: { args: ["auth", "status"], loggedIn: claudeLoggedIn },
    binEnvVar: "CLAUDE_CODE_EXECUTABLE",
    displayName: "Claude Code",
    fallbackPricingModel: "claude-sonnet",
    loginArgs: ["auth", "login"],
  },
  codex: {
    acpEntry: "@agentclientprotocol/codex-acp/dist/index.js",
    // `codex login status` exits 0 either way and says how you're logged in
    authProbe: { args: ["login", "status"], loggedIn: (out) => !/not logged in/iu.test(out) },
    binEnvVar: "CODEX_PATH",
    displayName: "Codex",
    fallbackPricingModel: "gpt-5.5-codex",
    loginArgs: ["login"],
    sessionModeId: "read-only",
  },
} satisfies Record<RunnerId, RunnerAdapter>;
