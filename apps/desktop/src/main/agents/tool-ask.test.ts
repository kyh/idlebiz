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

  it("does not take a shell command that starts like a title for MCP", () => {
    expect(ask({ rawInput: { command: "mcp.sh --run" } }).kind).toBe("shell");
  });
});
