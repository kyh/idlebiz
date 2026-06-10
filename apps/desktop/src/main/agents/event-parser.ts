// Flatten a raw pi AgentSessionEvent into a normalized PiEvent.
// CRITICAL (inteligir-discovered): stopReason/errorMessage/usage live on
// event.message, NOT the event root — reading from root silently swallows
// provider/auth errors. This parser never throws; returns null for ignored events.

export interface PiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "message_update"; delta: string }
  | { type: "message_end"; role: string; text: string; stopReason?: string; errorMessage?: string; usage?: PiUsage }
  | { type: "turn_end"; usage?: PiUsage }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_end"; toolCallId: string; toolName?: string; isError: boolean; resultText: string };

// ---- safe accessors (single parse-boundary narrowing) ----------------------
function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
const s = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const n = (v: unknown): number => (typeof v === "number" ? v : 0);

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const o = obj(b);
        return o.type === "text" ? s(o.text) ?? "" : "";
      })
      .join("");
  }
  return "";
}

function extractUsage(message: unknown): PiUsage | undefined {
  const u = obj(obj(message).usage);
  if (Object.keys(u).length === 0) return undefined;
  return {
    inputTokens: n(u.input ?? u.inputTokens ?? u.prompt_tokens),
    outputTokens: n(u.output ?? u.outputTokens ?? u.completion_tokens),
    cachedTokens: n(u.cacheRead ?? u.cachedInputTokens ?? u.cached_tokens),
  };
}

export function parsePiEvent(raw: unknown): PiEvent | null {
  const e = obj(raw);
  const type = s(e.type);
  switch (type) {
    case "agent_start":
      return { type: "agent_start" };
    case "agent_end":
      return { type: "agent_end" };
    case "message_update": {
      const ame = obj(e.assistantMessageEvent);
      if (ame.type === "text_delta") return { type: "message_update", delta: s(ame.delta) ?? "" };
      return null;
    }
    case "message_end": {
      const m = obj(e.message);
      return {
        type: "message_end",
        role: s(m.role) ?? "assistant",
        text: extractText(m.content),
        stopReason: s(m.stopReason),
        errorMessage: s(m.errorMessage),
        usage: extractUsage(m),
      };
    }
    case "turn_end":
      return { type: "turn_end", usage: extractUsage(e.message) };
    case "tool_execution_start":
      return { type: "tool_start", toolCallId: s(e.toolCallId) ?? "", toolName: s(e.toolName) ?? "tool", args: e.args };
    case "tool_execution_end":
      return {
        type: "tool_end",
        toolCallId: s(e.toolCallId) ?? "",
        toolName: s(e.toolName),
        isError: e.isError === true,
        resultText: extractText(e.result),
      };
    default:
      return null;
  }
}
