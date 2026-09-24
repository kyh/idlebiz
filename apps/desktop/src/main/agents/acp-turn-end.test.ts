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
  if (method === "session/set_mode") send({ id, result: {} });
  if (method === "session/prompt" && ${JSON.stringify(answer)} !== null) send({ id, ...JSON.parse(${JSON.stringify(answer)}) });
});
`;

/** An ACP agent that opens a session, then runs `onPrompt` (JS that can use `id` and `send`). */
const agentThat = (onPrompt: string): string => `
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { agentCapabilities: {}, protocolVersion: 1 } });
  if (method === "session/new") send({ id, result: { sessionId: "s1" } });
  if (method === "session/set_mode") send({ id, result: {} });
  if (method === "session/prompt") { ${onPrompt} }
});
`;

const PANIC = "thread 'main' panicked at src/main.rs:12:5";
const panics = `process.stderr.write(${JSON.stringify(PANIC)}, () => process.exit(101));`;
const orphans = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { stdio: "inherit" });`;

interface SessionFailure {
  actions: string[];
  category: string;
  severity: "error" | "warning";
  title: string;
}

const typedError = (category: string, actions: string[], title: string): SessionFailure => ({
  actions,
  category,
  severity: "error",
  title,
});

/**
 * codex-acp ending a turn on `failure`: on the prompt response to a client that declared typed
 * failures, and otherwise only in prose, the turn still ending end_turn.
 */
const failingAgent = (failure: SessionFailure, stderr = ""): string => `
process.stderr.write(${JSON.stringify(stderr)});
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const failure = ${JSON.stringify(failure)};
let typed = false;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    const air = params.clientCapabilities._meta?.jetbrains?.air;
    typed = Number.isInteger(air?.version) && air.version >= 1 && air.capabilities?.includes("sessionFailure") === true;
    send({ id, result: { agentCapabilities: {}, protocolVersion: 1 } });
  }
  if (method === "session/new") send({ id, result: { sessionId: "s1" } });
  if (method === "session/set_mode") send({ id, result: {} });
  if (method === "session/prompt") {
    if (!typed) {
      const content = { text: failure.title, type: "text" };
      send({ method: "session/update", params: { sessionId: "s1", update: { content, sessionUpdate: "agent_message_chunk" } } });
    }
    const _meta = typed ? { jetbrains: { air: { sessionFailure: failure, version: 1 } } } : {};
    send({ id, result: { _meta, stopReason: "end_turn" } });
  }
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
    agent: {
      command: [process.execPath, "-e", agentScript],
      env: {},
      sessionModeId: "default",
      typedFailures: true,
    },
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
        data: { errorKind: "rate_limit" },
        message: "You've hit your limit · try again in 2 hours",
      },
    });
    const before = Date.now();
    const { end } = await turn(scriptedAgent(refusal));
    expect(end).toMatchObject({
      error: "You've hit your limit · try again in 2 hours",
      kind: "limited",
    });
    const resetsAt = end.kind === "limited" ? end.resetsAt : 0;
    expect(resetsAt).toBeGreaterThanOrEqual(before + 2 * 3_600_000);
  });

  it("fails, never rests, when the watchdog ends it, though its text names a session limit", async () => {
    const { end } = await turn(scriptedAgent(null), 200);
    expect(end.kind).toBe("failed");
    expect(end.kind === "failed" ? end.error : end.kind).toContain("session limit");
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

describe("a turn whose agent dies mid-prompt", () => {
  it("fails with what the agent said on stderr, not the connection it dropped", async () => {
    const { end } = await turn(agentThat(panics));
    expect(end).toEqual({ error: PANIC, kind: "failed" });
  });

  it("fails on the agent's exit though a child of its own holds its pipes open", async () => {
    const { end } = await turn(agentThat(`${orphans}\n${panics}`));
    expect(end).toEqual({ error: PANIC, kind: "failed" });
  });

  it("fails at once with the agent's own error when it answers the prompt with one", async () => {
    const answers = `send({ id, error: { code: -32603, message: "Internal error" } });
process.stderr.write("shutting down");
setTimeout(() => process.exit(1), 200);`;
    const { end } = await turn(agentThat(answers));
    expect(end).toEqual({ error: "Internal error", kind: "failed" });
  });
});

describe("a turn the agent ended on a typed failure", () => {
  it("rests on a usage or rate limit until the time it names", async () => {
    const title = "You've hit your usage limit. Try again in 2 hours.";
    const before = Date.now();
    const { end } = await turn(failingAgent(typedError("limit", [], title)));
    expect(end).toMatchObject({ error: title, kind: "limited" });
    const resetsAt = end.kind === "limited" ? end.resetsAt : 0;
    expect(resetsAt).toBeGreaterThanOrEqual(before + 2 * 3_600_000);

    const rate = await turn(failingAgent(typedError("limit", ["retry"], "Rate limit reached")));
    expect(rate.end.kind).toBe("limited");
  });

  it("rests on an overloaded service, for a default park when it names no time", async () => {
    const title = "Selected model is at capacity. Please try a different model.";
    const before = Date.now();
    const { end } = await turn(failingAgent(typedError("service", ["retry"], title)));
    expect(end).toMatchObject({ error: title, kind: "limited" });
    const resetsAt = end.kind === "limited" ? end.resetsAt : 0;
    expect(resetsAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
  });

  it("fails, never rests, on a service fault typed exactly as an overload but not one", async () => {
    const { end } = await turn(failingAgent(typedError("service", ["retry"], "Turn failed")));
    expect(end).toEqual({ error: "Turn failed", kind: "failed" });
  });

  it("fails, never rests, on an internal error, with what the agent said on stderr", async () => {
    const title = "Codex encountered an internal error.";
    const internal = typedError("service", ["retry", "new_session"], title);
    const { end } = await turn(failingAgent(internal));
    expect(end).toEqual({ error: title, kind: "failed" });

    const logged = await turn(failingAgent(internal, "ResponseError: turn/start failed"));
    expect(logged.end).toEqual({
      error: `${title}\nResponseError: turn/start failed`,
      kind: "failed",
    });
  });

  it("fails and spends the session when only a new one can go on", async () => {
    const title = "Codex ran out of room in the model's context window.";
    const { end, sessionId } = await turn(
      failingAgent(typedError("limit", ["new_session"], title)),
    );
    expect(end).toEqual({ error: title, kind: "failed", sessionSpent: true });
    expect(sessionId).toBe("s1");
  });

  it("fails, keeping the session, on any other error", async () => {
    const refused = await turn(failingAgent(typedError("request", [], "Bad request")));
    expect(refused.end).toEqual({ error: "Bad request", kind: "failed" });
    const lost = await turn(
      failingAgent(typedError("connection", ["retry", "new_session"], "Connection lost")),
    );
    expect(lost.end).toEqual({ error: "Connection lost", kind: "failed" });
  });

  it("completes when the agent reports no failure, or only a warning the turn got past", async () => {
    const clean = await turn(scriptedAgent(JSON.stringify({ result: { stopReason: "end_turn" } })));
    expect(clean.end).toEqual({ kind: "completed" });
    const warning = failingAgent({
      ...typedError("service", [], "Reconnecting…"),
      severity: "warning",
    });
    const { end } = await turn(warning);
    expect(end).toEqual({ kind: "completed" });
  });
});
