import { describe, expect, it } from "vitest";
import { toolAskOf } from "@repo/agent-driver/tool-ask";
import { holdFor } from "@/shared/command-policy";

const ask = (request: {
  rawInput?: unknown;
  meta?: unknown;
  title?: string;
  kind?: string;
  locations?: { path: string }[];
}) =>
  toolAskOf({
    kind: request.kind,
    locations: request.locations,
    meta: request.meta,
    rawInput: request.rawInput,
    title: request.title,
  });

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
      const room = { cwd: "/w", save: "/save", writable: ["/w"] };
      expect(await holdFor(tool, new Set(), () => Promise.resolve(null), room)).toEqual({
        key: `ask: ${title}`,
        leasable: false,
        rule: "unknown-ask",
      });
    },
  );

  it("reads claude's Write by the file it names, and any other path it locates", () => {
    const rawInput = { content: "{}", file_path: "../approvals.json" };
    expect(ask({ kind: "edit", rawInput, title: "Write ../approvals.json" })).toEqual({
      kind: "edit",
      paths: ["../approvals.json"],
    });
    const locations = [{ path: "../approvals.json" }, { path: "/save/acme/approvals.json" }];
    expect(ask({ kind: "edit", locations, rawInput, title: "Write ../approvals.json" })).toEqual({
      kind: "edit",
      paths: ["../approvals.json", "/save/acme/approvals.json"],
    });
  });

  it("reads codex's patch by its locations: the approval has no input", () => {
    const locations = [{ path: "/save/acme/bets/b/BET.md" }, { path: "/save/acme/workspace/a.ts" }];
    expect(ask({ kind: "edit", locations, title: "Edit files" })).toEqual({
      kind: "patch",
      paths: ["/save/acme/bets/b/BET.md", "/save/acme/workspace/a.ts"],
    });
    expect(ask({ kind: "edit", title: "Edit files" })).toEqual({ kind: "patch", paths: [] });
  });

  it("judges codex's patch by every path it locates, a move's destination too", async () => {
    const room = { cwd: "/w", save: "/save", writable: ["/w"] };
    const judge = (locations: { path: string }[]) =>
      holdFor(
        ask({ kind: "edit", locations, title: "Edit files" }),
        new Set(),
        () => Promise.resolve(null),
        room,
      );
    expect(await judge([{ path: "/w/notes.md" }])).toBeNull();
    expect(await judge([{ path: "/w/notes.md" }, { path: "/save/acme/approvals.json" }])).toEqual({
      key: "edit: /w/notes.md, /save/acme/approvals.json",
      leasable: false,
      rule: "save-edit",
    });
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
    const room = { cwd: "/w", save: "/save", writable: ["/w"] };
    expect(await holdFor(url, new Set(), () => Promise.resolve(null), room)).not.toBeNull();
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

  it("knows codex widening its own sandbox by the input, not the title", () => {
    const rawInput = {
      cwd: "/work",
      environmentId: "env-1",
      permissions: {
        fileSystem: { read: null, write: ["/Users/me/.npm"] },
        network: { enabled: true },
      },
    };
    expect(ask({ rawInput, title: "Additional sandbox permissions" })).toEqual({
      kind: "sandbox",
      network: true,
      paths: ["/Users/me/.npm"],
    });
    expect(
      ask({ rawInput: { cwd: "/work", permissions: { network: { enabled: true } } } }),
    ).toEqual({ kind: "sandbox", network: true, paths: [] });
  });

  it("still knows a widening whose fields changed type", () => {
    const rawInput = { permissions: { fileSystem: { read: "/etc" }, network: { enabled: "yes" } } };
    expect(ask({ rawInput, title: "Additional sandbox permissions" })).toEqual({
      kind: "sandbox",
      network: true,
      paths: [],
    });
  });

  it("lists the paths and patterns a widening names only in its entries", () => {
    const entries = [
      { access: "write", path: { path: "/Users/me/.npm", type: "path" } },
      { access: "read", path: { pattern: "/Users/me/**/.env", type: "glob_pattern" } },
      { access: "write", path: { type: "special", value: { kind: "tmpdir" } } },
    ];
    const rawInput = { permissions: { fileSystem: { entries } } };
    expect(ask({ kind: "other", rawInput, title: "Additional sandbox permissions" })).toEqual({
      kind: "sandbox",
      network: false,
      paths: ["/Users/me/.npm", "/Users/me/**/.env"],
    });
  });

  it("knows a widening that names nothing it can list", () => {
    const rawInput = { permissions: { fileSystem: { entries: [] }, network: null } };
    expect(ask({ rawInput, title: "Additional sandbox permissions" })).toEqual({
      kind: "sandbox",
      network: false,
      paths: [],
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
