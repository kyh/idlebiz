import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { priceUsage } from "@repo/agent-driver/pricing";
import { RUNNERS } from "@repo/agent-driver/registry";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * An ACP agent shaped like codex-acp: resuming replays one usage update, the turn sends
 * one per model request (the second repeated), and the response covers only the last.
 */
const codexLikeAgent = `
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const used = (sessionId, tokens) =>
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", size: 400000, used: tokens } } });
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { agentCapabilities: { sessionCapabilities: { resume: {} } }, protocolVersion: 1 } });
  if (method === "session/resume") {
    used(params.sessionId, 90000);
    send({ id, result: {} });
  }
  if (method === "session/set_mode") send({ id, result: {} });
  if (method === "session/prompt") {
    for (const tokens of [1000, 2000, 2000, 3000]) used(params.sessionId, tokens);
    const usage = { cachedReadTokens: 1500, inputTokens: 900, outputTokens: 600, totalTokens: 3000 };
    send({ id, result: { stopReason: "end_turn", usage } });
  }
});
`;

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "idlebiz-usage-"));
});

afterEach(() => {
  rmSync(cwd, { force: true, recursive: true });
});

const turn = (usagePerRequest?: true) =>
  runAcpTurn({
    agent: {
      command: [process.execPath, "-e", codexLikeAgent],
      env: {},
      sessionModeId: "read-only",
      usagePerRequest,
    },
    cwd,
    idleTimeoutMs: 0,
    maxSessionMs: 0,
    onEvent: () => {},
    prompt: "work",
    resumeSessionId: "stored",
    systemPrompt: "",
    teardownGraceMs: 100,
  });

describe("a turn's token usage", () => {
  it("counts every model request of the turn when the agent reports only the last", async () => {
    const { usage } = await turn(true);
    expect(usage).toEqual({
      cachedTokens: 3000,
      costUsd: 0,
      inputTokens: 1800,
      outputTokens: 1200,
    });
  });

  it("is the response's own when the agent's updates are not per request", async () => {
    const { usage } = await turn();
    expect(usage).toEqual({ cachedTokens: 1500, costUsd: 0, inputTokens: 900, outputTokens: 600 });
  });
});

/** An agent that reports three requests' usage, then works on until the watchdog cuts the turn off. */
const cutOffAgent = `
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { agentCapabilities: {}, protocolVersion: 1 } });
  if (method === "session/new") send({ id, result: { sessionId: "s" } });
  if (method === "session/set_mode") send({ id, result: {} });
  if (method === "session/prompt") {
    for (const used of [100000, 200000, 300000]) {
      send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "usage_update", size: 400000, used } } });
    }
  }
});
`;

const cutOff = (usagePerRequest?: true) =>
  runAcpTurn({
    agent: {
      command: [process.execPath, "-e", cutOffAgent],
      env: {},
      sessionModeId: "default",
      usagePerRequest,
    },
    cwd,
    idleTimeoutMs: 0,
    maxSessionMs: 500,
    onEvent: () => {},
    prompt: "work",
    systemPrompt: "",
    teardownGraceMs: 100,
  });

describe("a turn cut off before the agent answered", () => {
  it("bills every request the agent reported", async () => {
    const { end, usage } = await cutOff(true);
    expect(end.kind).toBe("failed");
    expect(usage).toEqual({ cachedTokens: 0, costUsd: 0, inputTokens: 600_000, outputTokens: 0 });
    expect(priceUsage(RUNNERS.codex.fallbackRates, usage)).toBeGreaterThan(0);
  });

  it("bills at least the largest context the agent reported when its updates are not per request", async () => {
    const { end, usage } = await cutOff();
    expect(end.kind).toBe("failed");
    expect(usage).toEqual({ cachedTokens: 0, costUsd: 0, inputTokens: 300_000, outputTokens: 0 });
  });
});

describe("priceUsage", () => {
  it("prices tokens per million at the runner's rates", () => {
    const usage = {
      cachedTokens: 1_000_000,
      costUsd: 0,
      inputTokens: 2_000_000,
      outputTokens: 500_000,
    };
    expect(priceUsage(RUNNERS.codex.fallbackRates, usage)).toBeCloseTo(0.125 + 2.5 + 5);
  });
});
