import { z } from "zod";

/** What a permission request is asking to do, as the policy judges it. */
export type ToolAsk =
  /** A shell command, as the call's input names it. An `execute` call naming none is unknown: codex titles it with fixed copy ("Run command", "socks5Tcp network access to <host>"), never the command. */
  | { kind: "shell"; command: string }
  /** A tool from an MCP server in the player's own CLI settings, or that server asking something of its own (codex's elicitations: a question, a URL to open). `server` is null when nothing names it. */
  | { kind: "mcp"; server: string | null }
  /** codex asking to widen its own sandbox (request_permissions): once widened, later commands run inside it without asking. */
  | { kind: "sandbox"; network: boolean; paths: readonly string[] }
  /** A file edit by the agent's own tool, as the files it names; codex's patch names them only in the call's locations. */
  | { kind: "edit"; paths: readonly string[] }
  /** codex asking to let a command it does not name reach an http(s) host; it gives no other protocol a URL. `host` is null when the URL will not parse. */
  | { kind: "network"; host: string | null }
  /** A read of the web by the agent's own tool (claude's WebFetch and WebSearch). */
  | { kind: "fetch" }
  /** Anything else, known by nothing but its title. */
  | { kind: "unknown"; title: string };

const RawInput = z.object({
  command: z.string().optional(),
  /** codex names the MCP server here when the approval stands alone, and on every elicitation */
  serverName: z.string().optional(),
});

/** claude's Write and Edit name their file here. */
const EditInput = z.object({ file_path: z.string() });

/** codex's network approval, when no command comes with it. */
const NetworkInput = z.object({ url: z.string() });

/** codex's request_permissions, known by `permissions` alone. Each part is read on its own, so a field whose type changed still leaves a sandbox ask. */
const SandboxWiden = z.object({ permissions: z.looseObject({}) });
const WidenNetwork = z.object({ network: z.object({ enabled: z.unknown() }) });
const WidenRead = z.object({ fileSystem: z.object({ read: z.array(z.string()) }) });
const WidenWrite = z.object({ fileSystem: z.object({ write: z.array(z.string()) }) });
const WidenEntries = z.object({ fileSystem: z.object({ entries: z.array(z.unknown()) }) });
/** An entry names a path or a glob pattern; a special scope names neither. */
const WidenEntry = z.object({
  path: z.union([z.object({ path: z.string() }), z.object({ pattern: z.string() })]),
});

const sandboxAskOf = ({ permissions }: z.infer<typeof SandboxWiden>): ToolAsk => {
  const network = WidenNetwork.safeParse(permissions);
  const read = WidenRead.safeParse(permissions);
  const write = WidenWrite.safeParse(permissions);
  const entries = WidenEntries.safeParse(permissions);
  const named = (entries.success ? entries.data.fileSystem.entries : []).flatMap((entry) => {
    const parsed = WidenEntry.safeParse(entry);
    if (!parsed.success) {
      return [];
    }
    const { path } = parsed.data;
    return ["path" in path ? path.path : path.pattern];
  });
  const enabled = network.success ? network.data.network.enabled : undefined;
  return {
    kind: "sandbox",
    // an `enabled` of a type nobody expected still shows on the card
    network: enabled !== undefined && enabled !== null && enabled !== false,
    paths: [
      ...new Set([
        ...(read.success ? read.data.fileSystem.read : []),
        ...(write.success ? write.data.fileSystem.write : []),
        ...named,
      ]),
    ],
  };
};

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
  locations: readonly { path: string }[] | null | undefined;
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
  const widen = SandboxWiden.safeParse(request.rawInput);
  if (widen.success) {
    return sandboxAskOf(widen.data);
  }
  if (request.kind === "edit") {
    const located = (request.locations ?? []).map((location) => location.path);
    if (located.length > 0) {
      return { kind: "edit", paths: located };
    }
    const named = EditInput.safeParse(request.rawInput);
    return { kind: "edit", paths: named.success ? [named.data.file_path] : [] };
  }
  if (request.kind === "fetch") {
    return { kind: "fetch" };
  }
  const network = NetworkInput.safeParse(request.rawInput);
  if (network.success) {
    return { host: URL.parse(network.data.url)?.host || null, kind: "network" };
  }
  return { kind: "unknown", title: request.title ?? "" };
};
