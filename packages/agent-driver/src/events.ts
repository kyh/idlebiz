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
    };

export const zeroUsage = (): AgentUsage => ({
  cachedTokens: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
});

export const addUsage = (a: AgentUsage, b: AgentUsage): AgentUsage => ({
  cachedTokens: a.cachedTokens + b.cachedTokens,
  costUsd: a.costUsd + b.costUsd,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});
