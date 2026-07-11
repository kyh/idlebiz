// Normalized events a runner emits while a CLI agent session streams. The
// shape is the app-facing contract: the scheduler's feed and speech bubbles
// consume these without knowing which CLI produced them. Deliberately
// minimal — only what a consumer actually reads; usage/outcome arrive once
// via RunnerResult, not per-event.

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Real USD cost when the CLI reports one (claude); 0 means "price it from tokens". */
  costUsd: number;
}

export type AgentEvent =
  | { type: "message_end"; role: string; text: string }
  | { type: "tool_start"; toolName: string; args: unknown };

export const zeroUsage = (): AgentUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
});
