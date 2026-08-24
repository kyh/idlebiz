import { runAcpTurn } from "./acp-session";
import { acpAgentCommand } from "./acp-command";
import type { RunnerOptions, RunnerResult } from "./runner";

/**
 * Codex over ACP.
 *
 * `read-only` is not a restriction wanted for its own sake — it is the mode
 * that makes codex ASK. Its default (`agent`) runs commands without raising a
 * permission request at all, which silently disables the founder gate: measured
 * as zero permission requests and a write landing outside the workspace. The
 * policy layer auto-allows ordinary work, so asking costs nothing.
 */
export function runCodex(opts: RunnerOptions): Promise<RunnerResult> {
  return runAcpTurn(opts, {
    command: acpAgentCommand("@agentclientprotocol/codex-acp", "codex-acp"),
    sessionModeId: "read-only",
  });
}
