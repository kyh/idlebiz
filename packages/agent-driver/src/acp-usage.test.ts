import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { priceUsage } from "./pricing";
import { RUNNERS } from "./registry";
import { runAcpTurn } from "./acp-session";
import { usageMeter } from "./acp-usage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "idlebiz-usage-"));
});

afterEach(() => {
  rmSync(cwd, { force: true, recursive: true });
});

const used = (tokens: number): Extract<SessionUpdate, { sessionUpdate: "usage_update" }> => ({
  sessionUpdate: "usage_update",
  size: 400_000,
  used: tokens,
});

/**
 * A turn shaped like codex-acp's: resuming replays one usage update, the turn sends one per model
 * request (the second repeated), and the response covers only the last.
 */
const meteredTurn = (perRequest: boolean) => {
  const meter = usageMeter(perRequest);
  meter.onUpdate(used(90_000));
  meter.startPrompt();
  for (const tokens of [1000, 2000, 2000, 3000]) {
    meter.onUpdate(used(tokens));
  }
  meter.onResponse({
    cachedReadTokens: 1500,
    inputTokens: 900,
    outputTokens: 600,
    totalTokens: 3000,
  });
  return meter.total();
};

describe("a turn's token usage", () => {
  it("counts no update a resume replays before the prompt", () => {
    const meter = usageMeter(true);
    meter.onUpdate(used(90_000));
    meter.startPrompt();
    meter.onUpdate(used(1000));
    expect(meter.total().inputTokens).toBe(1000);
  });

  it("counts a request the agent re-sends unchanged once", () => {
    const meter = usageMeter(true);
    meter.startPrompt();
    meter.onUpdate(used(2000));
    meter.onUpdate(used(2000));
    expect(meter.total().inputTokens).toBe(2000);
  });

  it("counts every model request of the turn when the agent reports only the last", () => {
    expect(meteredTurn(true)).toEqual({
      cachedTokens: 3000,
      costUsd: 0,
      inputTokens: 1800,
      outputTokens: 1200,
    });
  });

  it("is the response's own when the agent's updates are not per request", () => {
    expect(meteredTurn(false)).toEqual({
      cachedTokens: 1500,
      costUsd: 0,
      inputTokens: 900,
      outputTokens: 600,
    });
  });

  it("keeps the largest running cost the agent reports, past its answer", () => {
    const meter = usageMeter(false);
    meter.startPrompt();
    meter.onUpdate({ ...used(1000), cost: { amount: 0.5, currency: "USD" } });
    meter.onUpdate({ ...used(2000), cost: { amount: 0.25, currency: "USD" } });
    meter.onResponse({ inputTokens: 900, outputTokens: 600, totalTokens: 1500 });
    expect(meter.total().costUsd).toBe(0.5);
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
