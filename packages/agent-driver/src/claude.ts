import { runAcpTurn } from "./acp-session";
import { acpAgentCommand } from "./acp-command";
import type { RunnerOptions, RunnerResult } from "./runner";

/**
 * Claude Code over ACP.
 *
 * Its default mode already routes tool calls through
 * `session/request_permission`, so the founder gate works without selecting a
 * session mode.
 */
export function runClaude(opts: RunnerOptions): Promise<RunnerResult> {
  return runAcpTurn(opts, {
    command: acpAgentCommand("@agentclientprotocol/claude-agent-acp", "claude-agent-acp"),
  });
}
