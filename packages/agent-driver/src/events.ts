// Normalized events a runner emits while a CLI agent session streams.
// The shape is the app-facing contract: the scheduler, activity feed and
// speech bubbles consume these without knowing which CLI produced them.

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Real USD cost when the CLI reports one (claude); 0 means "price it from tokens". */
  costUsd: number;
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "message_update"; delta: string }
  | {
      type: "message_end";
      role: string;
      text: string;
      stopReason?: string;
      errorMessage?: string;
      usage?: AgentUsage;
    }
  | { type: "turn_end"; usage?: AgentUsage }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName?: string;
      isError: boolean;
      resultText: string;
    };

export const zeroUsage = (): AgentUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
});
