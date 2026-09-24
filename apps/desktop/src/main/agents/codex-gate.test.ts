import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { runnerBin } from "@repo/agent-driver/detect";
import { endAllAgents, runAcpTurn } from "@repo/agent-driver/acp-session";
import type { PermissionRequest } from "@repo/agent-driver/acp-session";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { holdFor } from "@/shared/command-policy";
import type { Hold } from "@/shared/command-policy";
import { parseJson } from "@/shared/json";

// The real codex, driven through the app's codex-acp inside the seal, by a stand-in model on
// loopback: nothing is billed, and codex's home is a scratch one. It proves codex, whose own
// sandbox is off, still asks IdleBiz before it runs a command, so holdFor still judges it.

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-codex-gate-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const { acpAgentFor } = await import("./agent-driver");
const { sealRuns } = await import("./seal");

const codexRuns =
  process.platform === "darwin" && spawnSync(runnerBin("codex"), ["--version"]).status === 0;

/** The model's one tool call: an `exec_command` or an `apply_patch`; after its output, a last word. */
type Move = { tool: "exec_command"; cmd: string } | { tool: "apply_patch"; patch: string };

const ResponsesRequest = z.object({ input: z.array(z.looseObject({ type: z.string() })) });

const Listening = z.object({ port: z.number() });

/** What the stand-in model says in a turn: a last word, or one tool call. */
type ModelItem =
  | {
      type: "message";
      id: string;
      role: "assistant";
      content: { type: "output_text"; text: string }[];
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "custom_tool_call"; call_id: string; name: string; input: string };

type ModelEvent =
  | { type: "response.created"; response: { id: string } }
  | { type: "response.output_item.done"; item: ModelItem }
  | {
      type: "response.completed";
      response: {
        id: string;
        usage: {
          input_tokens: number;
          input_tokens_details: null;
          output_tokens: number;
          output_tokens_details: null;
          total_tokens: number;
        };
      };
    };

const sse = (events: readonly ModelEvent[]): string =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

const LAST_WORD: ModelItem = {
  content: [{ text: "done", type: "output_text" }],
  id: "msg_1",
  role: "assistant",
  type: "message",
};

const callOf = (move: Move): ModelItem =>
  move.tool === "exec_command"
    ? {
        arguments: JSON.stringify({ cmd: move.cmd }),
        call_id: "call_1",
        name: "exec_command",
        type: "function_call",
      }
    : { call_id: "call_1", input: move.patch, name: "apply_patch", type: "custom_tool_call" };

/** A Responses API that makes `move` first, then says "done". */
const standInModel = (move: () => Move): Server =>
  createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const parsed = ResponsesRequest.safeParse(parseJson(body));
      const answered =
        parsed.success && parsed.data.input.some((item) => item.type.endsWith("_call_output"));
      const item = answered ? LAST_WORD : callOf(move());
      const usage = {
        input_tokens: 1,
        input_tokens_details: null,
        output_tokens: 1,
        output_tokens_details: null,
        total_tokens: 2,
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse([
          { response: { id: "resp_1" }, type: "response.created" },
          { item, type: "response.output_item.done" },
          { response: { id: "resp_1", usage }, type: "response.completed" },
        ]),
      );
    });
  });

describe.skipIf(!codexRuns)("codex inside the seal", () => {
  let model: Server | null = null;
  let move: Move = { cmd: "true", tool: "exec_command" };
  let base = "";
  let codexHome = "";
  let workspace = "";
  let remote = "";

  beforeAll(async () => {
    const listening = standInModel(() => move);
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
    base = mkdtempSync(path.join(tmpdir(), "idlebiz-codex-run-"));
    const { port } = Listening.parse(model?.address());
    codexHome = path.join(base, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'model = "gpt-5.4"',
        'model_provider = "stand-in"',
        "[model_providers.stand-in]",
        'name = "stand-in"',
        `base_url = "http://127.0.0.1:${port}/v1"`,
        'wire_api = "responses"',
      ].join("\n"),
    );
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

  // an ended turn's codex may still be writing its session into its home
  afterEach(async () => {
    await endAllAgents(1000);
    rmSync(base, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  });

  /** One turn of `next`, every ask answered `allow`, and what holdFor made of each. */
  const turn = async (next: Move, allow: boolean) => {
    move = next;
    const state = await sealRuns();
    if (state.kind !== "sealed") {
      throw new Error(state.reason);
    }
    const asks: { request: PermissionRequest; held: Hold | null }[] = [];
    const room = { cwd: workspace, save: root, writable: [workspace] };
    const result = await runAcpTurn({
      agent: acpAgentFor("codex", state.seal),
      cwd: workspace,
      env: { CODEX_HOME: codexHome },
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
      const { asks, pushed } = await turn(
        { cmd: "git push origin main", tool: "exec_command" },
        false,
      );
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
    {
      timeout: 60_000,
    },
    async () => {
      const { pushed, result } = await turn(
        { cmd: "git push origin main", tool: "exec_command" },
        true,
      );
      expect(result.end).toEqual({ kind: "completed" });
      expect(pushed).toContain("refs/heads/main");
    },
  );

  it("asks before every patch, naming where a move lands", { timeout: 60_000 }, async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: notes.md",
      `*** Move to: ${path.join(root, "acme", "approvals.json")}`,
      "@@",
      "-a",
      "+b",
      "*** End Patch",
    ].join("\n");
    const { asks } = await turn({ patch, tool: "apply_patch" }, false);
    expect(asks.map(({ held }) => held?.rule)).toEqual(["save-edit"]);
    expect(asks[0]?.request.tool).toEqual({
      kind: "patch",
      paths: [path.join(workspace, "notes.md"), path.join(root, "acme", "approvals.json")],
    });
  });
});
