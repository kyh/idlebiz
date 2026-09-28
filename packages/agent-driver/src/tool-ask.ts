import { z } from "zod";

/** What a permission request is asking to do, as the policy judges it. */
export type ToolAsk =
  /** A shell command, as the call's input names it. An `execute` call naming none is unknown: codex titles it with fixed copy ("Run command", "socks5Tcp network access to <host>"), never the command. */
  | { kind: "shell"; command: string }
  /** A tool from an MCP server in the player's own CLI settings, or that server asking something of its own (codex's elicitations: a question, a URL to open). `server` is null when nothing names it. */
  | { kind: "mcp"; server: string | null }
  /** codex asking to widen its own sandbox (request_permissions): once widened, later commands run inside it without asking. */
  | { kind: "sandbox" }
  /** A file edit by the agent's own tool: claude's Write and Edit, codex's patch. The run's seal decides where it may write. */
  | { kind: "edit" }
  /** codex asking to let a command it does not name reach an http(s) host; it gives no other protocol a URL. `host` is null when the URL will not parse. */
  | { kind: "network"; host: string | null }
  /** A read of the web by the agent's own tool (claude's WebFetch and WebSearch). */
  | { kind: "fetch" }
  /** A read of files by the agent's own tool (claude's Read, Grep and Glob). The run's seal decides what it may read. */
  | { kind: "read" }
  /** Anything else, known by nothing but its title. */
  | { kind: "unknown"; title: string };

const RawInput = z.object({
  command: z.string().optional(),
  /** codex names the MCP server here when the approval stands alone, and on every elicitation */
  serverName: z.string().optional(),
});

/** codex's network approval, when no command comes with it. */
const NetworkInput = z.object({ url: z.string() });

/** codex's request_permissions, known by `permissions` alone, whatever it asks for. */
const SandboxWiden = z.object({ permissions: z.looseObject({}) });

/** codex marks an MCP tool approval in the request's `_meta`; its tool call may carry no title at all. */
const McpApprovalMeta = z.object({ is_mcp_tool_approval: z.literal(true) });

/** claude titles an MCP call `mcp__<server>__<tool>`, codex `mcp.<server>.<tool>`. */
const mcpServerOf = (title: string): string | null => {
  const named = /^mcp(?:__(?<claude>.+?)__|\.(?<codex>[^.\s]+)\.)/u.exec(title)?.groups;
  return named?.claude ?? named?.codex ?? null;
};

/**
 * Both runners' dialects end here, so the policy never parses a wire format.
 * `title` is the request's own, or the one announced earlier for the same call
 * id: an approval may name only the id. What this cannot recognise is unknown,
 * never a command: a title is adapter copy, and no rule would match it.
 */
export const toolAskOf = (request: {
  rawInput: unknown;
  meta: unknown;
  title: string | undefined;
  /** ACP tool kind — "execute", "edit", "fetch", … */
  kind: string | null | undefined;
}): ToolAsk => {
  const parsed = RawInput.safeParse(request.rawInput);
  const input = parsed.success ? parsed.data : {};
  if (input.command !== undefined) {
    return { command: input.command, kind: "shell" };
  }
  const titled = request.title === undefined ? null : mcpServerOf(request.title);
  // before fetch: codex's URL elicitation is kind "fetch" too, and only the server name tells it from a web read
  if (
    titled !== null ||
    input.serverName !== undefined ||
    McpApprovalMeta.safeParse(request.meta).success
  ) {
    return { kind: "mcp", server: input.serverName ?? titled };
  }
  if (SandboxWiden.safeParse(request.rawInput).success) {
    return { kind: "sandbox" };
  }
  if (request.kind === "edit") {
    return { kind: "edit" };
  }
  if (request.kind === "fetch") {
    return { kind: "fetch" };
  }
  // codex asks for a command as "execute" however it reads, so these are only the agent's own tools
  if (request.kind === "read" || request.kind === "search") {
    return { kind: "read" };
  }
  const network = NetworkInput.safeParse(request.rawInput);
  if (network.success) {
    return { host: URL.parse(network.data.url)?.host ?? null, kind: "network" };
  }
  return { kind: "unknown", title: request.title ?? "" };
};
