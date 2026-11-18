import { z } from "zod";

/** What a permission request is asking to do, as the policy judges it. */
export type ToolAsk =
  | { kind: "shell"; command: string }
  | { kind: "mcp"; server: string | null }
  | { kind: "sandbox" }
  | { kind: "edit" }
  | { kind: "network"; host: string | null }
  | { kind: "fetch" }
  | { kind: "read" }
  | { kind: "unknown"; title: string };

const RawInput = z.object({
  command: z.string().optional(),
  serverName: z.string().optional(),
});

const NetworkInput = z.object({ url: z.string() });

const SandboxWiden = z.object({ permissions: z.looseObject({}) });

const McpApprovalMeta = z.object({ is_mcp_tool_approval: z.literal(true) });

const mcpServerOf = (title: string) => {
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
}) => {
  const parsed = RawInput.safeParse(request.rawInput);
  const input = parsed.success ? parsed.data : {};

  if (input.command !== undefined) {
    return { command: input.command, kind: "shell" } satisfies ToolAsk;
  }

  const titled = request.title === undefined ? null : mcpServerOf(request.title);

  if (
    titled !== null ||
    input.serverName !== undefined ||
    McpApprovalMeta.safeParse(request.meta).success
  ) {
    return { kind: "mcp", server: input.serverName ?? titled } satisfies ToolAsk;
  }

  if (SandboxWiden.safeParse(request.rawInput).success) {
    return { kind: "sandbox" } satisfies ToolAsk;
  }

  if (request.kind === "edit") {
    return { kind: "edit" } satisfies ToolAsk;
  }

  if (request.kind === "fetch") {
    return { kind: "fetch" } satisfies ToolAsk;
  }

  if (request.kind === "read" || request.kind === "search") {
    return { kind: "read" } satisfies ToolAsk;
  }

  const network = NetworkInput.safeParse(request.rawInput);

  if (network.success) {
    return { host: URL.parse(network.data.url)?.host ?? null, kind: "network" } satisfies ToolAsk;
  }

  return { kind: "unknown", title: request.title ?? "" } satisfies ToolAsk;
};
