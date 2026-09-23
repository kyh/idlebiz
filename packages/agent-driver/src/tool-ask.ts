import { z } from "zod";

/** What a permission request is asking to do, as the policy judges it. */
export type ToolAsk =
  /** A shell command — or a bare title, which codex sends for a command it announced earlier, so it is judged as one. */
  | { kind: "shell"; command: string }
  /** A tool from an MCP server in the player's own CLI settings. `server` is null when nothing names it. */
  | { kind: "mcp"; server: string | null }
  /** codex asking to widen its own sandbox (request_permissions): once widened, later commands run inside it without asking. */
  | { kind: "sandbox"; network: boolean; paths: readonly string[] };

const RawInput = z.object({
  command: z.string().optional(),
  /** codex names the MCP server here when the approval stands alone */
  serverName: z.string().optional(),
});

const SandboxWiden = z.object({
  permissions: z.object({
    fileSystem: z
      .object({ read: z.array(z.string()).nullish(), write: z.array(z.string()).nullish() })
      .nullish(),
    network: z.object({ enabled: z.boolean().nullish() }).nullish(),
  }),
});

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
 * id: an approval may name only the id.
 */
export const toolAskOf = (request: {
  rawInput: unknown;
  meta: unknown;
  title: string | undefined;
}): ToolAsk => {
  const parsed = RawInput.safeParse(request.rawInput);
  const input = parsed.success ? parsed.data : {};
  if (input.command !== undefined) {
    return { command: input.command, kind: "shell" };
  }
  const titled = request.title === undefined ? null : mcpServerOf(request.title);
  if (titled !== null || McpApprovalMeta.safeParse(request.meta).success) {
    return { kind: "mcp", server: input.serverName ?? titled };
  }
  // Known by its input, never its title: the title is adapter copy, and the fallback below would pass it as a command.
  const widen = SandboxWiden.safeParse(request.rawInput);
  if (widen.success) {
    const { fileSystem, network } = widen.data.permissions;
    return {
      kind: "sandbox",
      network: network?.enabled === true,
      paths: [...(fileSystem?.read ?? []), ...(fileSystem?.write ?? [])],
    };
  }
  return { command: request.title ?? "", kind: "shell" };
};
