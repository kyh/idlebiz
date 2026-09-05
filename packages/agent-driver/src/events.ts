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

import type { ToolKind } from "@agentclientprotocol/sdk";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Real USD cost when the CLI reports one (claude); 0 means "price it from tokens". */
  costUsd: number;
}

export type AgentEvent =
  | { type: "message_end"; text: string }
  | {
      type: "tool_start";
      /** The agent's title for the call ("Read src/app.ts") — prose, differs per CLI. */
      toolName: string;
      /** ACP's own discriminant for what the call does. The stable key to react on. */
      kind?: ToolKind;
      args: unknown;
    };

export const zeroUsage = (): AgentUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
});
