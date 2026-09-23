import { describe, expect, it } from "vitest";
import { toolAskOf } from "@repo/agent-driver/tool-ask";

const ask = (request: { rawInput?: unknown; meta?: unknown; title?: string }) =>
  toolAskOf({ meta: request.meta, rawInput: request.rawInput, title: request.title });

describe("toolAskOf", () => {
  it("reads a shell command from the call's input", () => {
    expect(ask({ rawInput: { command: "git push" }, title: "Push" })).toEqual({
      command: "git push",
      kind: "shell",
    });
  });

  it("judges a bare title as a command: codex approves a call it announced by id", () => {
    expect(ask({ title: "vercel deploy --prod" })).toEqual({
      command: "vercel deploy --prod",
      kind: "shell",
    });
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
