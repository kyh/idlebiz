import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { runnerBin } from "@repo/agent-driver/detect";
import { endAllAgents, runAcpTurn } from "@repo/agent-driver/acp-session";
import type { PermissionRequest } from "@repo/agent-driver/acp-session";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { holdFor } from "@/shared/command-policy";
import type { Hold } from "@/shared/command-policy";
import { parseJson } from "@/shared/json";

// The real codex, driven through the app's codex-acp inside the seal, by a stand-in model on
// loopback: nothing is billed, and codex's home is a scratch one. It proves codex, whose own
// sandbox is off, still asks IdleBiz before it runs a command, so holdFor still judges it,
// starts no MCP server of the founder's, and runs, but cannot rewrite, the config their own
// codex loads.

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-codex-gate-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const { acpAgentFor, codexMcpOff } = await import("./agent-driver");
const { machineSeal, realPathOf, sealRuns } = await import("./seal");

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

/** `make` with HOME at `home`, where the seal and the run's env look for the founder's files. */
const asFounderAt = async <T>(home: string, make: () => Promise<T>): Promise<T> => {
  vi.stubEnv("HOME", home);
  try {
    return await make();
  } finally {
    vi.unstubAllEnvs();
  }
};

describe.skipIf(!codexRuns)("codex inside the seal", () => {
  let model: Server | null = null;
  let move: Move = { cmd: "true", tool: "exec_command" };
  let base = "";
  let home = "";
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
    home = path.join(base, "home");
    // where the founder's codex keeps its config, so the seal treats it as theirs
    codexHome = path.join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'model = "gpt-5.4"',
        'model_provider = "stand-in"',
        "[model_providers.stand-in]",
        'name = "stand-in"',
        `base_url = "http://127.0.0.1:${port}/v1"`,
        'wire_api = "responses"',
        // a server of the founder's, which leaves a mark if a run starts it
        "[mcp_servers.founder]",
        'command = "/bin/sh"',
        `args = ["-c", "touch ${path.join(base, "mcp-started")}; exec cat"]`,
      ].join("\n"),
    );
    remote = path.join(base, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    // a run's own folders are always in the save
    workspace = mkdtempSync(path.join(root, "workspace-"));
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
    for (const dir of [base, workspace]) {
      rmSync(dir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  });

  /** One turn of `next`, every ask answered `allow`, and what holdFor made of each. */
  const turn = async (next: Move, allow: boolean) => {
    move = next;
    const state = await sealRuns();
    if (state.kind !== "sealed") {
      throw new Error(state.reason);
    }
    const asks: { request: PermissionRequest; held: Hold | null }[] = [];
    const room = { cwd: workspace, real: realPathOf, writable: [workspace] };
    const agent = await asFounderAt(home, async () => {
      const seal = await machineSeal([workspace]);
      return acpAgentFor("codex", seal, await codexMcpOff(seal, { CODEX_HOME: codexHome }));
    });
    const result = await runAcpTurn({
      agent,
      cwd: workspace,
      env: { CODEX_HOME: codexHome },
      idleTimeoutMs: 60_000,
      maxSessionMs: 90_000,
      onEvent: () => {},
      onPermission: async (request) => {
        const held =
          request.tool.kind === "sandbox"
            ? null
            : await holdFor(request.tool, new Set(), () => Promise.resolve(null), room);
        asks.push({ held, request });
        return { allow };
      },
      prompt: "work",
      systemPrompt: "",
      teardownGraceMs: 500,
    });
    const pushed = execFileSync("git", ["for-each-ref"], { cwd: remote }).toString();
    return { asks, mcpStarted: existsSync(path.join(base, "mcp-started")), pushed, result };
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

  it("starts none of the founder's MCP servers", { timeout: 60_000 }, async () => {
    const { mcpStarted, result } = await turn({ cmd: "true", tool: "exec_command" }, true);
    expect(result.end).toEqual({ kind: "completed" });
    expect(mcpStarted).toBe(false);
  });

  it("runs each command inside the seal", { timeout: 60_000 }, async () => {
    const secrets = path.join(root, "secrets.json");
    writeFileSync(secrets, "sealed canary");
    const outside = path.join(root, "outside.txt");
    const cmd = `cat ${secrets} > read.txt; echo x > ${outside}; touch ran`;
    const { result } = await turn({ cmd, tool: "exec_command" }, true);
    expect(result.end).toEqual({ kind: "completed" });
    expect(existsSync(path.join(workspace, "ran"))).toBe(true);
    expect(readFileSync(path.join(workspace, "read.txt"), "utf-8")).toBe("");
    expect(existsSync(outside)).toBe(false);
  });

  it(
    "lets a patch through unheld, and the seal refuses one that moves a file into the save",
    { timeout: 60_000 },
    async () => {
      const approvals = path.join(root, "acme", "approvals.json");
      mkdirSync(path.dirname(approvals), { recursive: true });
      const patch = [
        "*** Begin Patch",
        "*** Update File: notes.md",
        `*** Move to: ${approvals}`,
        "@@",
        "-a",
        "+b",
        "*** End Patch",
      ].join("\n");
      const { asks } = await turn({ patch, tool: "apply_patch" }, true);
      expect(asks.map(({ held, request }) => ({ held, tool: request.tool }))).toEqual([
        { held: null, tool: { kind: "edit" } },
      ]);
      expect(existsSync(approvals)).toBe(false);
      expect(readFileSync(path.join(workspace, "notes.md"), "utf-8")).toBe("a\n");
    },
  );

  it(
    "runs with its founder's config unwritable, and cannot rewrite it",
    { timeout: 60_000 },
    async () => {
      const config = path.join(codexHome, "config.toml");
      const before = readFileSync(config, "utf-8");
      // a script `notify` could name
      const script = path.join(codexHome, "notify.py");
      const cmd = `touch ran; echo 'notify = ["x"]' >> ${config}; echo 'x' > ${script}`;
      const { result } = await turn({ cmd, tool: "exec_command" }, true);
      expect(result.end).toEqual({ kind: "completed" });
      expect(existsSync(path.join(workspace, "ran"))).toBe(true);
      expect(readFileSync(config, "utf-8")).toBe(before);
      expect(existsSync(script)).toBe(false);
    },
  );
});
