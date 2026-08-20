// Normalized events a runner emits while a CLI agent session streams. The
// shape is the app-facing contract: the scheduler's feed and speech bubbles
// consume these without knowing which CLI produced them. Deliberately
// minimal — only what a consumer actually reads; the run's final outcome
// arrives via RunnerResult.
//
// `usage` is the exception to "outcome arrives at the end": a spend cap that
// is only checked between runs is not a ceiling, because one run can cost
// several dollars. These deltas let a caller stop a run that is still going.
// Granularity is whatever the CLI gives us — claude reports per assistant
// turn, codex only once when the turn completes.

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Real USD cost when the CLI reports one (claude); 0 means "price it from tokens". */
  costUsd: number;
}

export type AgentEvent =
  | { type: "message_end"; role: string; text: string }
  | { type: "tool_start"; toolName: string; args: unknown }
  /** Tokens spent since the last usage event — a delta, never a running total. */
  | { type: "usage"; usage: AgentUsage };

export const zeroUsage = (): AgentUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
});
