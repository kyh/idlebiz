import { execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { runnerBin } from "@repo/agent-driver/detect";
import { endAllAgents, runAcpTurn } from "@repo/agent-driver/acp-session";
import type { AcpAgent, PermissionRequest } from "@repo/agent-driver/acp-session";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { holdFor } from "../command-policy";
import type { Hold } from "../command-policy";
import { parseJson } from "@repo/domain/json";
import { DEPLOY_TIMEOUT_MS } from "../tool-specs";

// The real claude, driven through the app's claude-agent-acp inside the seal, by a stand-in
// model on loopback: nothing is billed, and claude's config dir is a scratch one whose settings
// turn claude's own sandbox on, as a founder's may. It proves the session's flag-tier settings
// keep that sandbox off, so a command runs inside the seal instead of failing to nest, and
// still asks IdleBiz first, so holdFor still judges it; that it offers no plan mode, whose exit
// would ask the founder to approve a plan; that no MCP server of the founder's starts;
// that the model is offered IdleBiz's skills and none of the founder's, nor their instructions,
// but the notes the team keeps in the workspace's AGENTS.md, while the env of their settings
// still reaches the run and the model and effort they picked are the ones asked; and that a run
// cannot rewrite the settings or account file the founder's own claude loads, and still runs and
// keeps its transcript.

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-claude-gate-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const { sessionAgent } = await import("./agent-driver");
const { machineSeal, realPathOf, sealRuns } = await import("./seal");

const claudeRuns =
  process.platform === "darwin" && spawnSync(runnerBin("claude"), ["--version"]).status === 0;

/**
 * A founder's settings that would sandbox, and skip asking for, every command, with an env a
 * sign-in kept there would set, and a model and effort other than claude's defaults.
 */
const FOUNDER_SETTINGS = {
  effortLevel: "low",
  env: { IDLEBIZ_GATE_SIGN_IN: "from-settings" },
  model: "sonnet",
  permissions: { allow: ["Bash"] },
  sandbox: { autoAllowBashIfSandboxed: true, enabled: true },
};

/** Where `name` is described as `marker`, for a request that lists it to be found by. */
const plantSkill = (skills: string, name: string, marker: string): void => {
  mkdirSync(path.join(skills, name), { recursive: true });
  writeFileSync(
    path.join(skills, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${marker}. Use it for any work at all.\n---\n\n${marker}\n`,
  );
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

/** The model a request asks for, and how hard it is to think. */
const Asked = z.object({
  model: z.string(),
  output_config: z.object({ effort: z.string() }).optional(),
});

const Listening = z.object({ port: z.number() });

/** One call of claude's own tools: a shell command, or a file read. */
interface ToolCall {
  name: "Bash" | "Read";
  input: Record<string, string>;
}

/** What the stand-in model says in a turn: a last word, or one tool call. */
type Move = { type: "text"; text: string } | { type: "tool_use"; call: ToolCall };

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
        | { type: "tool_use"; id: string; name: ToolCall["name"]; input: Record<string, string> };
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
            content_block: { id: "toolu_1", input: {}, name: move.call.name, type: "tool_use" },
            index: 0,
            type: "content_block_start",
          },
          {
            delta: {
              partial_json: JSON.stringify(move.call.input),
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
 * A Messages API that makes `call`, then says "done"; a request of claude's own that offers no
 * Bash tool gets "done" too, and a token count is no turn. Each call's output lands in `outputs`, the tools each request
 * offering Bash offers in `offered`, and each such request whole in `sent`.
 */
const standInModel = (
  call: () => ToolCall,
  outputs: string[],
  offered: string[],
  sent: string[],
): Server =>
  createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      if (req.url?.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const parsed = MessagesRequest.safeParse(body === "" ? null : parseJson(body));
      const blocks = parsed.success ? parsed.data.messages.flatMap(({ content }) => content) : [];
      const results = blocks.filter(({ type }) => type === "tool_result");
      outputs.push(...results.map(({ content }) => content ?? ""));
      const tools = parsed.success ? (parsed.data.tools ?? []).map(({ name }) => name) : [];
      const offersBash = tools.includes("Bash");
      if (offersBash) {
        offered.push(...tools);
        sent.push(body);
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        streamed(
          offersBash && results.length === 0
            ? { call: call(), type: "tool_use" }
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

/** `make` with HOME at `home`, where the seal and the run's env look for the founder's files. */
const asFounderAt = async <T>(home: string, make: () => Promise<T>): Promise<T> => {
  vi.stubEnv("HOME", home);
  try {
    return await make();
  } finally {
    vi.unstubAllEnvs();
  }
};

describe.skipIf(!claudeRuns)("claude inside the seal", () => {
  let model: Server | null = null;
  let call: ToolCall = { input: { command: "true" }, name: "Bash" };
  const outputs: string[] = [];
  const offered: string[] = [];
  const sent: string[] = [];
  let base = "";
  let skills = "";
  let home = "";
  let configDir = "";
  let workspace = "";
  let remote = "";

  beforeAll(async () => {
    const listening = standInModel(() => call, outputs, offered, sent);
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
    offered.length = 0;
    sent.length = 0;
    base = mkdtempSync(path.join(tmpdir(), "idlebiz-claude-run-"));
    // IdleBiz's skills as shipped, and one more
    skills = path.join(base, "skills");
    cpSync(path.resolve(import.meta.dirname, "../../../resources/skills"), skills, {
      recursive: true,
    });
    plantSkill(path.join(skills, ".agents", "skills"), "bundled-gate", "BUNDLED_SKILL_MARK");
    home = path.join(base, "home");
    // where the founder's claude keeps its config, so the seal treats it as theirs
    configDir = path.join(home, ".claude");
    // main makes it before every claude run, which cannot
    mkdirSync(path.join(configDir, "projects"), { recursive: true });
    writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(FOUNDER_SETTINGS));
    plantSkill(path.join(configDir, "skills"), "founder-gate", "FOUNDER_SKILL_MARK");
    writeFileSync(path.join(configDir, "CLAUDE.md"), "FOUNDER_INSTRUCTIONS_MARK\n");
    // a server of the founder's, which leaves a mark if a run starts it
    const founderServer = {
      args: ["-c", `touch ${path.join(base, "mcp-started")}; exec cat`],
      command: "/bin/sh",
      type: "stdio",
    };
    writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ mcpServers: { founder: founderServer } }),
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
    // what the project would load, had a run written it
    plantSkill(path.join(workspace, ".claude", "skills"), "project-gate", "PROJECT_SKILL_MARK");
    writeFileSync(path.join(workspace, "CLAUDE.md"), "PROJECT_INSTRUCTIONS_MARK\n");
  });

  // an ended turn's claude may still be writing its session into its config dir
  afterEach(async () => {
    await endAllAgents(1000);
    for (const dir of [base, workspace]) {
      rmSync(dir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
    }
  });

  /** One turn making `next`, every ask answered `allow`, and what holdFor made of each. */
  const turnOf = async (next: ToolCall, allow: boolean) => {
    call = next;
    const state = await sealRuns();
    if (state.kind !== "sealed") {
      throw new Error(state.reason);
    }
    const asks: { request: PermissionRequest; held: Hold | null }[] = [];
    const room = { cwd: workspace, real: realPathOf, writable: [workspace] };
    const { port } = Listening.parse(model?.address());
    const agent = await asFounderAt(home, async () =>
      standInAgent(await sessionAgent("claude", await machineSeal([workspace]), skills, workspace)),
    );
    const result = await runAcpTurn({
      agent,
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

  /** One turn running shell `command`, as `turnOf`. */
  const turn = (command: string, allow: boolean) =>
    turnOf({ input: { command }, name: "Bash" }, allow);

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

  it(
    "offers no plan mode, whose exit would hold the turn for the founder to approve a plan",
    { timeout: 60_000 },
    async () => {
      const { result } = await turn("true", true);
      expect(result.end).toEqual({ kind: "completed" });
      expect(offered).toContain("Bash");
      expect(offered).not.toContain("EnterPlanMode");
      expect(offered).not.toContain("ExitPlanMode");
    },
  );

  it(
    "is offered IdleBiz's skills and none of the founder's, the project's or claude's own, nor their instructions",
    { timeout: 60_000 },
    async () => {
      const { result } = await turn("true", true);
      expect(result.end).toEqual({ kind: "completed" });
      const requests = sent.join("\n");
      for (const name of readdirSync(path.join(skills, ".agents", "skills"))) {
        expect(requests).toContain(`idlebiz:${name}`);
      }
      expect(requests).toContain("BUNDLED_SKILL_MARK");
      for (const mark of [
        "FOUNDER_SKILL_MARK",
        "FOUNDER_INSTRUCTIONS_MARK",
        "PROJECT_SKILL_MARK",
        "PROJECT_INSTRUCTIONS_MARK",
        "claude-api",
      ]) {
        expect(requests).not.toContain(mark);
      }
    },
  );

  it(
    "is handed the notes the team keeps in the workspace's AGENTS.md, once, as the team's",
    { timeout: 60_000 },
    async () => {
      writeFileSync(path.join(workspace, "AGENTS.md"), "TEAM_NOTES_MARK\n");
      const { result } = await turn("true", true);
      expect(result.end).toEqual({ kind: "completed" });
      expect(sent.length).toBeGreaterThan(0);
      for (const request of sent) {
        expect(request.split("TEAM_NOTES_MARK")).toHaveLength(2);
        expect(request).toContain("Teammates wrote them, not the founder");
      }
    },
  );

  it("signs in with the env of the founder's settings", { timeout: 60_000 }, async () => {
    await turn("echo sign-in=$IDLEBIZ_GATE_SIGN_IN", true);
    expect(outputs.join("\n")).toContain("sign-in=from-settings");
  });

  it("asks for the model and effort the founder's settings pick", { timeout: 60_000 }, async () => {
    const { result } = await turn("true", true);
    expect(result.end).toEqual({ kind: "completed" });
    const asked = sent.map((body) => Asked.parse(parseJson(body)));
    expect(asked).not.toEqual([]);
    for (const request of asked) {
      expect(request.model).toMatch(/sonnet/u);
      expect(request.output_config).toEqual({ effort: "low" });
    }
  });

  it("gives its shell commands time to wait out a deploy", { timeout: 60_000 }, async () => {
    await turn("echo timeout=$BASH_DEFAULT_TIMEOUT_MS", true);
    expect(outputs.join("\n")).toContain(`timeout=${DEPLOY_TIMEOUT_MS + 60_000}`);
  });

  it("starts none of the founder's MCP servers", { timeout: 60_000 }, async () => {
    const { mcpStarted, result } = await turn("true", true);
    expect(result.end).toEqual({ kind: "completed" });
    expect(mcpStarted).toBe(false);
  });

  it(
    "reads a file outside its own folders with its own tool, unheld, as a bare `cat` would",
    { timeout: 60_000 },
    async () => {
      const outside = path.join(base, "notes-elsewhere.txt");
      writeFileSync(outside, "read from outside");
      const { asks, result } = await turnOf({ input: { file_path: outside }, name: "Read" }, true);
      expect(result.end).toEqual({ kind: "completed" });
      expect(asks.map(({ held, request }) => ({ held, tool: request.tool }))).toEqual([
        { held: null, tool: { kind: "read" } },
      ]);
      expect(outputs.join("\n")).toContain("read from outside");
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

  it(
    "runs with its founder's settings unwritable, and cannot rewrite them or add a script beside them",
    { timeout: 60_000 },
    async () => {
      const settings = path.join(configDir, "settings.json");
      // a script a setting could name, such as a status line
      const script = path.join(configDir, "statusline.sh");
      const { result } = await turn(
        `echo '{"hooks":{}}' > ${settings}; echo 'id' > ${script}`,
        true,
      );
      expect(result.end).toEqual({ kind: "completed" });
      expect(outputs.join("\n")).toMatch(/operation not permitted/iu);
      expect(readFileSync(settings, "utf-8")).toBe(JSON.stringify(FOUNDER_SETTINGS));
      expect(existsSync(script)).toBe(false);
    },
  );

  it(
    "keeps its transcript in its own folder's project, and names no MCP server in the founder's account file",
    { timeout: 60_000 },
    async () => {
      const account = path.join(configDir, ".claude.json");
      const before = readFileSync(account, "utf-8");
      const { result } = await turn(`echo '{"mcpServers":{}}' > ${account}`, true);
      expect(result.end).toEqual({ kind: "completed" });
      expect(outputs.join("\n")).toMatch(/operation not permitted/iu);
      expect(readFileSync(account, "utf-8")).toBe(before);
      const cwd = await realPathOf(workspace);
      const project = path.join(configDir, "projects", cwd.replaceAll(/[^a-zA-Z0-9]/gu, "-"));
      expect(readdirSync(project).some((file) => file.endsWith(".jsonl"))).toBe(true);
    },
  );
});
