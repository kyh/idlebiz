import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** An ACP agent advertising `capabilities` that answers session/resume with `resumeAnswer` (both JSON). */
const scriptedAgent = (capabilities: string, resumeAnswer: string): string => `
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { agentCapabilities: ${capabilities}, protocolVersion: 1 } });
  if (method === "session/resume") send({ id, ...${resumeAnswer} });
  if (method === "session/new") send({ id, result: { sessionId: "fresh" } });
  if (method === "session/prompt") send({ id, result: { stopReason: "end_turn" } });
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

const turn = (agentScript: string) =>
  runAcpTurn({
    agent: { command: [process.execPath, "-e", agentScript] },
    cwd,
    idleTimeoutMs: 0,
    maxSessionMs: 0,
    onEvent: () => {},
    prompt: "work",
    resumeSessionId: "stored",
    systemPrompt: "",
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
