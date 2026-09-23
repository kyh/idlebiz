import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * An ACP agent advertising `capabilities` that answers session/resume with `resumeAnswer`
 * (both JSON), and replies to a prompt with the text it was sent.
 */
const scriptedAgent = (capabilities: string, resumeAnswer: string): string => `
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { agentCapabilities: ${capabilities}, protocolVersion: 1 } });
  if (method === "session/resume") send({ id, ...${resumeAnswer} });
  if (method === "session/new") send({ id, result: { sessionId: "fresh" } });
  if (method === "session/set_mode") send({ id, result: {} });
  if (method === "session/prompt") {
    const content = { text: params.prompt[0].text, type: "text" };
    send({ method: "session/update", params: { sessionId: params.sessionId, update: { content, sessionUpdate: "agent_message_chunk" } } });
    send({ id, result: { stopReason: "end_turn" } });
  }
});
`;

const resumable = JSON.stringify({ sessionCapabilities: { resume: {} } });
const accepted = JSON.stringify({ result: {} });

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "idlebiz-resume-"));
});

afterEach(() => {
  rmSync(cwd, { force: true, recursive: true });
});

const turn = (agentScript: string, systemPrompt = "", instructionsChanged = false) =>
  runAcpTurn({
    agent: { command: [process.execPath, "-e", agentScript], sessionModeId: "default" },
    cwd,
    idleTimeoutMs: 0,
    instructionsChanged,
    maxSessionMs: 0,
    onEvent: () => {},
    prompt: "work",
    resumeSessionId: "stored",
    systemPrompt,
    teardownGraceMs: 100,
  });

describe("resuming a stored session", () => {
  it("resumes when the agent advertises session/resume", async () => {
    const result = await turn(scriptedAgent(resumable, accepted));
    expect(result).toMatchObject({
      end: { kind: "completed" },
      resumed: true,
      sessionId: "stored",
    });
  });

  it("starts fresh when the agent can only load sessions, not resume them", async () => {
    const result = await turn(scriptedAgent(JSON.stringify({ loadSession: true }), accepted));
    expect(result).toMatchObject({
      end: { kind: "completed" },
      resumed: false,
      sessionId: "fresh",
    });
  });

  it("starts fresh when the agent rejects the stored session", async () => {
    const rejected = JSON.stringify({ error: { code: -32_002, message: "Resource not found" } });
    const result = await turn(scriptedAgent(resumable, rejected));
    expect(result).toMatchObject({
      end: { kind: "completed" },
      resumed: false,
      sessionId: "fresh",
    });
  });
});

describe("standing instructions", () => {
  const rules = "Mark every bet link with its path.";
  const rejected = JSON.stringify({ error: { code: -32_002, message: "Resource not found" } });

  it("are not sent again to a resumed session that already holds them", async () => {
    const { summary } = await turn(scriptedAgent(resumable, accepted), rules, false);
    expect(summary).toBe("work");
  });

  it("are sent again, said to have changed, when they differ from what the session was given", async () => {
    const { summary } = await turn(scriptedAgent(resumable, accepted), rules, true);
    expect(summary).toBe(
      `Your standing instructions changed. They now read:\n\n${rules}\n\n---\n\nYOUR TASK:\n\nwork`,
    );
  });

  it("are sent once, as to any new session, when the resume falls back to a fresh one", async () => {
    const { summary } = await turn(scriptedAgent(resumable, rejected), rules, true);
    expect(summary).toBe(`${rules}\n\n---\n\nYOUR TASK:\n\nwork`);
  });
});
