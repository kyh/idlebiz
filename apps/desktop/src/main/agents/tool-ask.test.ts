import { describe, expect, it } from "vitest";
import { toolAskOf } from "@repo/agent-driver/tool-ask";
import type { ToolAsk } from "@repo/agent-driver/tool-ask";
import { holdFor } from "@/shared/command-policy";
import type { Confinement } from "@/shared/command-policy";

const ask = (request: { rawInput?: unknown; meta?: unknown; title?: string; kind?: string }) =>
  toolAskOf({
    kind: request.kind,
    meta: request.meta,
    rawInput: request.rawInput,
    title: request.title,
  });

const ROOM: Confinement = {
  cwd: "/w",
  real: (file) => Promise.resolve(file),
  writable: ["/w"],
};

/** A widening never reaches the policy: the run refuses it first. */
const judge = async (tool: ToolAsk) => {
  if (tool.kind === "sandbox") {
    throw new Error("a widening is refused before it is judged");
  }
  return await holdFor(tool, new Set(), () => Promise.resolve(null), ROOM);
};

describe("toolAskOf", () => {
  it("reads a shell command from the call's input", () => {
    expect(ask({ rawInput: { command: "git push" }, title: "Push" })).toEqual({
      command: "git push",
      kind: "shell",
    });
  });

  it.each(["socks5Tcp network access to db.example.com", "Run command"])(
    "holds codex's execute approval that names no command, by its title: %s",
    async (title) => {
      const tool = ask({ kind: "execute", rawInput: { cwd: "/w" }, title });
      expect(tool).toEqual({ kind: "unknown", title });
      expect(await judge(tool)).toEqual({
        key: `ask: ${title}`,
        leasable: false,
        rule: "unknown-ask",
      });
    },
  );

  it("lets claude's Write and codex's patch through wherever they write: the seal decides", async () => {
    const write = ask({
      kind: "edit",
      rawInput: { content: "{}", file_path: "../approvals.json" },
      title: "Write ../approvals.json",
    });
    const patch = ask({ kind: "edit", title: "Edit files" });
    for (const tool of [write, patch]) {
      expect(tool).toEqual({ kind: "edit" });
      expect(await judge(tool)).toBeNull();
    }
  });

  it("names the host codex asks a command it does not show to reach", () => {
    const rawInput = { cwd: "/work", url: "https://x.com" };
    expect(ask({ kind: "execute", rawInput, title: "https network access to x.com" })).toEqual({
      host: "x.com",
      kind: "network",
    });
    expect(ask({ kind: "execute", rawInput: { url: "not a url" } })).toEqual({
      host: null,
      kind: "network",
    });
  });

  it("knows claude reading the web by the tool's kind, not its URL", () => {
    const rawInput = { prompt: "summarise", url: "https://docs.example.com" };
    expect(ask({ kind: "fetch", rawInput, title: "Fetch https://docs.example.com" })).toEqual({
      kind: "fetch",
    });
    expect(
      ask({ kind: "fetch", rawInput: { query: "pricing" }, title: 'Search "pricing"' }),
    ).toEqual({
      kind: "fetch",
    });
  });

  it.each([
    { kind: "read", rawInput: { file_path: "/etc/hosts" }, title: "Read /etc/hosts" },
    { kind: "search", rawInput: { path: "/tmp", pattern: "TODO" }, title: 'grep "TODO" /tmp' },
    { kind: "search", rawInput: { pattern: "**/*.md" }, title: "Find `**/*.md`" },
  ])(
    "lets claude's own reads through wherever they look, as a bare `cat` runs: $title",
    async (request) => {
      const tool = ask(request);
      expect(tool).toEqual({ kind: "read" });
      expect(await judge(tool)).toBeNull();
    },
  );

  it.each([
    { kind: "think", title: "Update TODOs: ship" },
    { kind: "other", title: "NotebookEdit" },
    { kind: undefined, title: "vercel deploy --prod" },
    { kind: "execute", title: undefined },
  ])("reads what it cannot recognise as unknown, never as a command: $kind $title", (request) => {
    expect(ask(request)).toEqual({ kind: "unknown", title: request.title ?? "" });
  });

  it("names the MCP server in either runner's dialect", () => {
    expect(ask({ title: "mcp__claude-in-chrome__computer" })).toEqual({
      kind: "mcp",
      server: "claude-in-chrome",
    });
    expect(ask({ title: "mcp.slack.post_message" })).toEqual({ kind: "mcp", server: "slack" });
    expect(
      ask({ meta: { is_mcp_tool_approval: true }, rawInput: { serverName: "gmail" } }),
    ).toEqual({ kind: "mcp", server: "gmail" });
  });

  it("holds codex's MCP elicitations as the server's, not as a web read or unknown", async () => {
    const url = ask({
      kind: "fetch",
      rawInput: {
        description: "Authorize",
        serverName: "stripe",
        url: "https://connect.stripe.com/x",
      },
      title: "MCP server requests to open a URL",
    });
    expect(url).toEqual({ kind: "mcp", server: "stripe" });
    expect(await judge(url)).not.toBeNull();
    expect(
      ask({
        kind: "other",
        rawInput: { description: "Which account?", schema: {}, serverName: "gmail" },
        title: "Question from MCP server",
      }),
    ).toEqual({ kind: "mcp", server: "gmail" });
  });

  it("keeps an MCP approval nothing names as MCP, unnamed", () => {
    expect(ask({ meta: { is_mcp_tool_approval: true } })).toEqual({ kind: "mcp", server: null });
  });

  it.each([
    {
      cwd: "/work",
      environmentId: "env-1",
      permissions: {
        fileSystem: { read: null, write: ["/Users/me/.npm"] },
        network: { enabled: true },
      },
    },
    { permissions: { fileSystem: { read: "/etc" }, network: { enabled: "yes" } } },
    { permissions: { fileSystem: { entries: [] }, network: null } },
  ])("knows codex widening its own sandbox by the input, whatever it asks for: %j", (rawInput) => {
    expect(ask({ kind: "other", rawInput, title: "Additional sandbox permissions" })).toEqual({
      kind: "sandbox",
    });
  });

  it("keeps an MCP tool that takes permissions as MCP", () => {
    const rawInput = { permissions: { role: "writer" } };
    expect(ask({ rawInput, title: "mcp__drive__share" })).toEqual({ kind: "mcp", server: "drive" });
  });

  it("does not take a shell command that starts like a title for MCP", () => {
    expect(ask({ rawInput: { command: "mcp.sh --run" } }).kind).toBe("shell");
  });
});
