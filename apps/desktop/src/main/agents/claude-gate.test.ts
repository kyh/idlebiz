import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { runnerBin } from "@repo/agent-driver/detect";
import { endAllAgents, runAcpTurn } from "@repo/agent-driver/acp-session";
import type { AcpAgent, PermissionRequest } from "@repo/agent-driver/acp-session";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { holdFor } from "@/shared/command-policy";
import type { Hold } from "@/shared/command-policy";
import { parseJson } from "@/shared/json";

// The real claude, driven through the app's claude-agent-acp inside the seal, by a stand-in
// model on loopback: nothing is billed, and claude's config dir is a scratch one whose settings
// turn claude's own sandbox on, as a founder's may. It proves the session's flag-tier settings
// keep that sandbox off, so a command runs inside the seal instead of failing to nest, and
// still asks IdleBiz first, so holdFor still judges it.

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-claude-gate-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const { acpAgentFor } = await import("./agent-driver");
const { machineSeal, realPathOf, sealRuns } = await import("./seal");

const claudeRuns =
  process.platform === "darwin" && spawnSync(runnerBin("claude"), ["--version"]).status === 0;

/** A founder's settings that would sandbox, and skip asking for, every command. */
const FOUNDER_SETTINGS = {
  permissions: { allow: ["Bash"] },
  sandbox: { autoAllowBashIfSandboxed: true, enabled: true },
};

/** A tool's output as claude hands it back: text, or blocks of it. */
const ToolOutput = z.union([
  z.string(),
  z
    .array(z.looseObject({ text: z.string().optional() }))
    .transform((blocks) => blocks.map(({ text }) => text ?? "").join("")),
]);

const MessagesRequest = z.object({
  messages: z.array(
    z.object({
      content: z.union([
        z.string().transform(() => []),
        z.array(z.looseObject({ content: ToolOutput.optional(), type: z.string() })),
      ]),
    }),
  ),
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
});

const Listening = z.object({ port: z.number() });

/** What the stand-in model says in a turn: a last word, or one command. */
type Move = { type: "text"; text: string } | { type: "tool_use"; command: string };

type ModelEvent =
  | {
      type: "message_start";
      message: {
        id: string;
        type: "message";
        role: "assistant";
        model: string;
        content: [];
        stop_reason: null;
        stop_sequence: null;
        usage: { input_tokens: number; output_tokens: number };
      };
    }
  | {
      type: "content_block_start";
      index: 0;
      content_block:
        | { type: "text"; text: "" }
        | { type: "tool_use"; id: string; name: "Bash"; input: Record<string, string> };
    }
  | {
      type: "content_block_delta";
      index: 0;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: 0 }
  | {
      type: "message_delta";
      delta: { stop_reason: "end_turn" | "tool_use"; stop_sequence: null };
      usage: { output_tokens: number };
    }
  | { type: "message_stop" };

const sse = (events: readonly ModelEvent[]): string =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

/** `move` as the Messages API streams it. */
const streamed = (move: Move): string =>
  sse([
    {
      message: {
        content: [],
        id: "msg_1",
        model: "stand-in",
        role: "assistant",
        stop_reason: null,
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      type: "message_start",
    },
    ...(move.type === "text"
      ? ([
          { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" },
          { delta: { text: move.text, type: "text_delta" }, index: 0, type: "content_block_delta" },
        ] satisfies ModelEvent[])
      : ([
          {
            content_block: { id: "toolu_1", input: {}, name: "Bash", type: "tool_use" },
            index: 0,
            type: "content_block_start",
          },
          {
            delta: {
              partial_json: JSON.stringify({ command: move.command }),
              type: "input_json_delta",
            },
            index: 0,
            type: "content_block_delta",
          },
        ] satisfies ModelEvent[])),
    { index: 0, type: "content_block_stop" },
    {
      delta: { stop_reason: move.type === "text" ? "end_turn" : "tool_use", stop_sequence: null },
      type: "message_delta",
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);

/**
 * A Messages API that runs `command` through the Bash tool, then says "done"; a request of
 * claude's own that offers no Bash tool gets "done" too. Each command's output lands in `outputs`.
 */
const standInModel = (command: () => string, outputs: string[]): Server =>
  createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const parsed = MessagesRequest.safeParse(body === "" ? null : parseJson(body));
      const blocks = parsed.success ? parsed.data.messages.flatMap(({ content }) => content) : [];
      const results = blocks.filter(({ type }) => type === "tool_result");
      outputs.push(...results.map(({ content }) => content ?? ""));
      const offersBash = parsed.success && parsed.data.tools?.some(({ name }) => name === "Bash");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        streamed(
          offersBash === true && results.length === 0
            ? { command: command(), type: "tool_use" }
            : { text: "done", type: "text" },
        ),
      );
    });
  });

/**
 * The app's claude agent, less what could reach past the stand-ins: this process's own claude
 * session, when the tests run inside one, and the Keychain, where claude looks for a login.
 */
const standInAgent = (agent: AcpAgent): AcpAgent => {
  const [bin = "", flag = "", profile = "", ...rest] = agent.command;
  const inherited = /^(?:ANTHROPIC_|CLAUDE|CMUX_)/u;
  return {
    ...agent,
    command: [bin, flag, `${profile}\n(deny process-exec (literal "/usr/bin/security"))`, ...rest],
    env: Object.fromEntries(
      Object.entries(agent.env).filter(
        ([name]) => name === "CLAUDE_CODE_EXECUTABLE" || !inherited.test(name),
      ),
    ),
  };
};

describe.skipIf(!claudeRuns)("claude inside the seal", () => {
  let model: Server | null = null;
  let command = "true";
  const outputs: string[] = [];
  let base = "";
  let configDir = "";
  let workspace = "";
  let remote = "";

  beforeAll(async () => {
    const listening = standInModel(() => command, outputs);
    model = listening;
    listening.listen(0, "127.0.0.1");
    await once(listening, "listening");
  });

  afterAll(() => {
    model?.close();
    rmSync(root, { force: true, recursive: true });
    if (previousRoot === undefined) {
      delete process.env.IDLEBIZ_ROOT_DIR;
    } else {
      process.env.IDLEBIZ_ROOT_DIR = previousRoot;
    }
  });

  beforeEach(() => {
    outputs.length = 0;
    base = mkdtempSync(path.join(tmpdir(), "idlebiz-claude-run-"));
    configDir = path.join(base, "claude-config");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(FOUNDER_SETTINGS));
    remote = path.join(base, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    workspace = path.join(base, "workspace");
    mkdirSync(workspace);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", ...args], {
        cwd: workspace,
      });
    git("init", "-q", "-b", "main");
    writeFileSync(path.join(workspace, "notes.md"), "a\n");
    git("add", ".");
    git("commit", "-qm", "a");
    git("remote", "add", "origin", remote);
  });

  // an ended turn's claude may still be writing its session into its config dir
  afterEach(async () => {
    await endAllAgents(1000);
    rmSync(base, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  });

  /** One turn running `next`, every ask answered `allow`, and what holdFor made of each. */
  const turn = async (next: string, allow: boolean) => {
    command = next;
    const state = await sealRuns();
    if (state.kind !== "sealed") {
      throw new Error(state.reason);
    }
    const asks: { request: PermissionRequest; held: Hold | null }[] = [];
    const room = { cwd: workspace, real: realPathOf, save: root, writable: [workspace] };
    const { port } = Listening.parse(model?.address());
    const result = await runAcpTurn({
      agent: standInAgent(acpAgentFor("claude", await machineSeal())),
      cwd: workspace,
      env: {
        ANTHROPIC_API_KEY: "stand-in",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CONFIG_DIR: configDir,
      },
      idleTimeoutMs: 60_000,
      maxSessionMs: 90_000,
      onEvent: () => {},
      onPermission: async (request) => {
        const held = await holdFor(request.tool, new Set(), () => Promise.resolve(null), room);
        asks.push({ held, request });
        return { allow };
      },
      prompt: "work",
      systemPrompt: "",
      teardownGraceMs: 500,
    });
    const pushed = execFileSync("git", ["for-each-ref"], { cwd: remote }).toString();
    return { asks, pushed, result };
  };

  it(
    "asks before a push, which holdFor holds and a denial stops",
    { timeout: 60_000 },
    async () => {
      const { asks, pushed } = await turn("git push origin main", false);
      expect(asks.map(({ held, request }) => ({ held, tool: request.tool }))).toEqual([
        {
          held: { key: "git push origin main", leasable: false, rule: "git-push" },
          tool: { command: "git push origin main", kind: "shell" },
        },
      ]);
      expect(pushed).toBe("");
    },
  );

  it(
    "runs what it was allowed, with no sandbox of its own to fail inside the seal",
    { timeout: 60_000 },
    async () => {
      const { pushed, result } = await turn("git push origin main", true);
      expect(result.end).toEqual({ kind: "completed" });
      expect(pushed).toContain("refs/heads/main");
    },
  );

  it("runs each command inside the seal", { timeout: 60_000 }, async () => {
    const secrets = path.join(root, "secrets.json");
    writeFileSync(secrets, "sealed canary");
    writeFileSync(path.join(workspace, "own.txt"), "the run's own");
    await turn(`cat own.txt; cat ${secrets}`, true);
    const output = outputs.join("\n");
    expect(output).toContain("the run's own");
    expect(output).toContain("Operation not permitted");
    expect(output).not.toContain("sealed canary");
  });
});
