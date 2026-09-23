import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import type { AcpAgent, AcpTurnOptions, PermissionRequest } from "@repo/agent-driver/acp-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonRecordSchema, parseJson } from "@/shared/json";

/**
 * An ACP agent that can resume, logs each request it is sent to `requests.jsonl`, and
 * answers session/set_mode with `setMode` (JSON). Given `options` (JSON), it asks
 * mid-prompt to run `git push` and replies with the outcome it was answered. Given
 * `announced`, it first announces the call under that title and asks by its id alone, as codex does.
 */
const scriptedAgent = ({
  announced = null,
  options = null,
  setMode = JSON.stringify({ result: {} }),
}: {
  announced?: string | null;
  options?: string | null;
  setMode?: string;
}): string => `
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let prompt;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (method) require("node:fs").appendFileSync("requests.jsonl", line + "\\n");
  if (method === "initialize") send({ id, result: { agentCapabilities: { sessionCapabilities: { resume: {} } }, protocolVersion: 1 } });
  if (method === "session/resume") send({ id, result: {} });
  if (method === "session/new") send({ id, result: { sessionId: "fresh" } });
  if (method === "session/set_mode") send({ id, ...${setMode} });
  if (method === "session/prompt") {
    prompt = { id, sessionId: params.sessionId };
    const options = ${options ?? "null"};
    const announced = ${JSON.stringify(announced)};
    if (announced !== null) send({ method: "session/update", params: { sessionId: params.sessionId, update: { kind: "execute", sessionUpdate: "tool_call", title: announced, toolCallId: "t1" } } });
    const toolCall = announced === null ? { rawInput: { command: "git push" }, title: "git push", toolCallId: "t1" } : { toolCallId: "t1" };
    if (options === null) send({ id, result: { stopReason: "end_turn" } });
    else send({ id: "ask", method: "session/request_permission", params: { options, sessionId: params.sessionId, toolCall } });
  }
  if (id === "ask" && method === undefined) {
    const content = { text: JSON.stringify(message.result.outcome), type: "text" };
    send({ method: "session/update", params: { sessionId: prompt.sessionId, update: { content, sessionUpdate: "agent_message_chunk" } } });
    send({ id: prompt.id, result: { stopReason: "end_turn" } });
  }
});
`;

const option = (kind: string, optionId: string) => ({ kind, name: optionId, optionId });

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "idlebiz-permission-"));
});

afterEach(() => {
  rmSync(cwd, { force: true, recursive: true });
});

const turn = (
  agentScript: string,
  more: Partial<
    Pick<AcpTurnOptions, "maxSessionMs" | "onEvent" | "onPermission" | "resumeSessionId">
  > & {
    sessionMeta?: AcpAgent["sessionMeta"];
  } = {},
) =>
  runAcpTurn({
    agent: {
      command: [process.execPath, "-e", agentScript],
      sessionMeta: more.sessionMeta,
      sessionModeId: "default",
    },
    cwd,
    idleTimeoutMs: 0,
    maxSessionMs: more.maxSessionMs ?? 0,
    onEvent: more.onEvent ?? (() => {}),
    onPermission: more.onPermission,
    prompt: "work",
    resumeSessionId: more.resumeSessionId,
    systemPrompt: "",
    teardownGraceMs: 100,
  });

const Sent = z.object({ method: z.string(), params: jsonRecordSchema });

const requestsSent = (): z.infer<typeof Sent>[] =>
  readFileSync(path.join(cwd, "requests.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => Sent.parse(parseJson(line)));

const paramsOf = (method: string) => requestsSent().find((r) => r.method === method)?.params;

describe("the session mode", () => {
  it("is set before the prompt on a fresh session", async () => {
    const { end } = await turn(scriptedAgent({}));
    expect(end.kind).toBe("completed");
    expect(requestsSent().map((r) => r.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_mode",
      "session/prompt",
    ]);
    expect(paramsOf("session/set_mode")).toEqual({ modeId: "default", sessionId: "fresh" });
  });

  it("is set again on a resumed session, which comes back in its default", async () => {
    const { end, resumed } = await turn(scriptedAgent({}), { resumeSessionId: "stored" });
    expect(end.kind).toBe("completed");
    expect(resumed).toBe(true);
    expect(requestsSent().map((r) => r.method)).toEqual([
      "initialize",
      "session/resume",
      "session/set_mode",
      "session/prompt",
    ]);
    expect(paramsOf("session/set_mode")).toEqual({ modeId: "default", sessionId: "stored" });
  });

  it("fails the turn before it prompts when the agent refuses it", async () => {
    const refusal = JSON.stringify({
      error: { code: -32_602, message: "Mode default is not available in this session" },
    });
    const { end } = await turn(scriptedAgent({ setMode: refusal }));
    expect(end).toEqual({
      error: "Mode default is not available in this session",
      kind: "failed",
    });
    expect(requestsSent().map((r) => r.method)).not.toContain("session/prompt");
  });
});

describe("the options a session is given", () => {
  const sessionMeta = { claudeCode: { options: { allowDangerouslySkipPermissions: false } } };

  it("ride on a new session", async () => {
    await turn(scriptedAgent({}), { sessionMeta });
    expect(paramsOf("session/new")).toMatchObject({ _meta: sessionMeta });
  });

  it("ride on a resumed session", async () => {
    await turn(scriptedAgent({}), { resumeSessionId: "stored", sessionMeta });
    expect(paramsOf("session/resume")).toMatchObject({ _meta: sessionMeta });
  });
});

describe("answering a permission ask", () => {
  it("signs only the one-time option, though an always one is offered first", async () => {
    const asks: PermissionRequest[] = [];
    const options = JSON.stringify([
      option("allow_always", "always"),
      option("allow_once", "once"),
    ]);
    const { summary } = await turn(scriptedAgent({ options }), {
      onPermission: (request) => {
        asks.push(request);
        return Promise.resolve({ allow: true });
      },
    });
    expect(asks.map((ask) => ask.tool)).toEqual([{ command: "git push", kind: "shell" }]);
    expect(parseJson(summary)).toEqual({ optionId: "once", outcome: "selected" });
  });

  it("cancels, never signing for always, when no one-time option is offered", async () => {
    const options = JSON.stringify([option("allow_always", "always"), option("reject_once", "no")]);
    const { summary } = await turn(scriptedAgent({ options }), {
      onPermission: () => Promise.resolve({ allow: true }),
    });
    expect(parseJson(summary)).toEqual({ outcome: "cancelled" });
  });

  it("refuses once, though a lasting refusal is offered first", async () => {
    const options = JSON.stringify([
      option("allow_once", "once"),
      option("reject_always", "never"),
      option("reject_once", "no"),
    ]);
    const { summary } = await turn(scriptedAgent({ options }), {
      onPermission: () => Promise.resolve({ allow: false }),
    });
    expect(parseJson(summary)).toEqual({ optionId: "no", outcome: "selected" });
  });

  it("tells an ask still waiting on the founder that the turn is over", async () => {
    const options = JSON.stringify([option("allow_once", "once")]);
    let toldOver = false;
    const { end } = await turn(scriptedAgent({ options }), {
      maxSessionMs: 300,
      onPermission: (_request, signal) =>
        // oxlint-disable-next-line promise/avoid-new -- resolves on an abort event, not a promise API
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            toldOver = true;
            resolve({ allow: false });
          });
        }),
    });
    expect(end).toMatchObject({ error: expect.stringContaining("session limit"), kind: "failed" });
    expect(toldOver).toBe(true);
  });
});

describe("a tool call the agent announces", () => {
  const body = `${"API_TOKEN=hunter2\n".repeat(300)}EOF`;
  const longLine = `printf '%s' ${"x".repeat(200)} > big.txt && cat > notes.md <<'EOF'`;

  it.each([
    {
      name: `${longLine.slice(0, 160)}…`,
      title: `${longLine}\n${body}`,
      what: "capped at 160 chars",
    },
    {
      name: "cat > .env <<'EOF'",
      title: `cat > .env <<'EOF'\n${body}`,
      what: "the heredoc body left out",
    },
  ])(
    "is named by its title's first line ($what), yet judged by the whole title",
    async ({ name, title }) => {
      const names: string[] = [];
      const asks: PermissionRequest[] = [];
      const { end } = await turn(
        scriptedAgent({
          announced: title,
          options: JSON.stringify([option("allow_once", "once")]),
        }),
        {
          onEvent: (event) => {
            if (event.type === "tool_start") {
              names.push(event.toolName);
            }
          },
          onPermission: (request) => {
            asks.push(request);
            return Promise.resolve({ allow: true });
          },
        },
      );
      expect(end.kind).toBe("completed");
      expect(names).toEqual([name]);
      expect(asks.map((ask) => ask.tool)).toEqual([{ kind: "unknown", title }]);
    },
  );
});
