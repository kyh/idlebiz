import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** An ACP agent that opens a session, then answers the prompt with `answer` (JSON), or never. */
const scriptedAgent = (answer: string | null, stderr = ""): string => `
process.stderr.write(${JSON.stringify(stderr)});
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { agentCapabilities: {}, protocolVersion: 1 } });
  if (method === "session/new") send({ id, result: { sessionId: "s1" } });
  if (method === "session/prompt" && ${JSON.stringify(answer)} !== null) send({ id, ...JSON.parse(${JSON.stringify(answer)}) });
});
`;

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "idlebiz-turn-end-"));
});

afterEach(() => {
  rmSync(cwd, { force: true, recursive: true });
});

const turn = (agentScript: string, maxSessionMs = 0) =>
  runAcpTurn({
    agent: { command: [process.execPath, "-e", agentScript] },
    cwd,
    idleTimeoutMs: 0,
    maxSessionMs,
    onEvent: () => {},
    prompt: "work",
    systemPrompt: "",
    teardownGraceMs: 100,
  });

describe("how a turn ends", () => {
  it("is limited when the agent refuses the prompt for a usage limit", async () => {
    const refusal = JSON.stringify({
      error: {
        code: -32_603,
        data: { codexErrorInfo: "usageLimitExceeded", message: "try again in 2 hours" },
        message: "Internal error",
      },
    });
    const before = Date.now();
    const { end } = await turn(scriptedAgent(refusal));
    expect(end).toMatchObject({ error: "Internal error", kind: "limited" });
    const resetsAt = end.kind === "limited" ? end.resetsAt : 0;
    expect(resetsAt).toBeGreaterThanOrEqual(before + 2 * 3_600_000);
  });

  it("fails, never rests, when the watchdog ends it, though its text names a session limit", async () => {
    const { end } = await turn(scriptedAgent(null), 200);
    expect(end.kind).toBe("failed");
    expect(end).toMatchObject({ error: expect.stringContaining("session limit") });
  });

  it("leads with the agent's stop reason, then what it said on stderr", async () => {
    const stopped = JSON.stringify({ result: { stopReason: "refusal" } });
    const { end } = await turn(scriptedAgent(stopped, "You've hit your usage limit"));
    expect(end).toEqual({
      error: "agent stopped: refusal\nYou've hit your usage limit",
      kind: "failed",
    });
  });
});
