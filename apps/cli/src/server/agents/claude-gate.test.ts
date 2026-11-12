import { execFileSync, spawnSync } from "node:child_process";
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
import { tmpdir } from "node:os";
import path from "node:path";
import { runnerBin } from "@repo/agent-driver/detect";
import { endAllAgents, runAcpTurn } from "@repo/agent-driver/acp-session";
import type { AcpAgent } from "@repo/agent-driver/acp-session";
import type { ToolAsk } from "@repo/agent-driver/tool-ask";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJson } from "@repo/domain/json";
import { DEPLOY_TIMEOUT_MS } from "../tool-specs";
import { sessionAgent } from "./session";
import { realPathOf } from "@repo/sandbox/machine";
import { sandboxOf, sandboxRuns } from "./sandbox";
import { tempSave } from "../test-support/save";
import { STAND_IN_KEY, startStandInModel } from "../test-support/stand-in-model";
import type { Move, StandInModel } from "../test-support/stand-in-model";

// The real claude, driven through the app's claude-agent-acp inside the sandbox, by the stand-in
// model on loopback (test-support/stand-in-model.ts): nothing is billed, and claude's config dir
// is a scratch one whose settings turn claude's own sandbox on, as a founder's may. It proves the
// session's flag-tier settings keep that sandbox off, so a command runs inside the sandbox instead of
// failing to nest; that behind a gateway, where it runs in Manual, it asks IdleBiz first, and in
// auto mode leaves a command to claude's own check; that it offers no plan mode, whose exit would
// ask the founder to approve a plan; that no MCP server of the founder's starts; that the model is offered IdleBiz's skills and none of the founder's, nor
// their instructions, but the notes the team keeps in the workspace's AGENTS.md, while the env of
// their settings still reaches the run and the model and effort they picked are the ones asked;
// and that a run cannot rewrite the settings or account file the founder's own claude loads, and
// still runs and keeps its transcript.

const root = tempSave();

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

/** The model a request asks for, and how hard it is to think. */
const Asked = z.object({
  model: z.string(),
  output_config: z.object({ effort: z.string() }).optional(),
});

/** What every turn's prompt carries, so the stand-in answers it with the turn's move. */
const TURN = "CLAUDE-GATE";

/**
 * The app's claude agent, less what could reach past the stand-ins: this process's own claude
 * session, when the tests run inside one, and the Keychain, where claude looks for a login.
 */
const standInAgent = (agent: AcpAgent): AcpAgent => {
  const [bin, flag = "", profile = "", ...rest] = agent.command;
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

/** `make` with HOME at `home`, where the sandbox and the run's env look for the founder's files. */
const asFounderAt = async <T>(home: string, make: () => Promise<T>): Promise<T> => {
  vi.stubEnv("HOME", home);
  try {
    return await make();
  } finally {
    vi.unstubAllEnvs();
  }
};

describe.skipIf(!claudeRuns)("claude inside the sandbox", () => {
  let model: StandInModel;
  let base = "";
  let skills = "";
  let home = "";
  let configDir = "";
  let workspace = "";
  let remote = "";

  beforeAll(async () => {
    model = await startStandInModel();
  });

  afterAll(async () => {
    await model.close();
  });

  /** Each call's output, as claude handed it back. */
  const outputs = () => model.toolOutputs(TURN).join("\n");

  /** Each request of the turn's own, which offers Bash, whole. */
  const turnRequests = () =>
    model.requests.filter(
      ({ protocol, tools }) => protocol === "messages" && tools.includes("Bash"),
    );

  /** The tools each request of the turn's own offers. */
  const offered = () => turnRequests().flatMap(({ tools }) => tools);

  const sent = () => turnRequests().map(({ body }) => body);

  beforeEach(() => {
    model.reset();
    base = mkdtempSync(path.join(tmpdir(), "idlebiz-claude-run-"));
    // IdleBiz's skills as shipped, and one more
    skills = path.join(base, "skills");
    cpSync(path.resolve(import.meta.dirname, "../../../resources/skills"), skills, {
      recursive: true,
    });
    plantSkill(path.join(skills, ".agents", "skills"), "bundled-gate", "BUNDLED_SKILL_MARK");
    home = path.join(base, "home");
    // where the founder's claude keeps its config, so the sandbox treats it as theirs
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

  /** One turn making `next` in the mode main picks, unless `mode` names another, every ask answered `allow`. */
  const turnOf = async (next: Move, allow: boolean, mode?: string) => {
    model.script(TURN, [next]);
    const state = await sandboxRuns();
    if (state.kind !== "sandboxed") {
      throw new Error(state.reason);
    }
    const asks: ToolAsk[] = [];
    const made = await asFounderAt(home, async () =>
      standInAgent(await sessionAgent("claude", await sandboxOf([workspace]), skills, workspace)),
    );
    const agent = mode === undefined ? made : { ...made, sessionMode: () => mode };
    const result = await runAcpTurn({
      agent,
      cwd: workspace,
      env: {
        ANTHROPIC_API_KEY: STAND_IN_KEY,
        ANTHROPIC_BASE_URL: model.url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CONFIG_DIR: configDir,
      },
      idleTimeoutMs: 60_000,
      maxSessionMs: 90_000,
      onEvent: () => {},
      onPermission: (tool) => {
        asks.push(tool);
        return Promise.resolve({ allow });
      },
      prompt: () => `${TURN} work`,
      teardownGraceMs: 500,
    });
    const pushed = execFileSync("git", ["for-each-ref"], { cwd: remote }).toString();
    return { asks, mcpStarted: existsSync(path.join(base, "mcp-started")), pushed, result };
  };

  /** One turn running shell `command`, as `turnOf`. */
  const turn = (command: string, allow: boolean) => turnOf({ command, kind: "shell" }, allow);

  it(
    "asks IdleBiz before a push behind a gateway, where it runs in Manual, and a denial stops it",
    { timeout: 60_000 },
    async () => {
      const { asks, pushed } = await turn("git push origin main", false);
      expect(asks).toEqual([{ command: "git push origin main", kind: "shell" }]);
      expect(pushed).toBe("");
    },
  );

  it(
    "leaves a push to auto mode's own check, refused where the check cannot run, and asks IdleBiz nothing",
    { timeout: 60_000 },
    async () => {
      const { asks, pushed, result } = await turnOf(
        { command: "git push origin main", kind: "shell" },
        true,
        "auto",
      );
      expect(result.end).toEqual({ kind: "completed" });
      expect(asks).toEqual([]);
      expect(pushed).toBe("");
    },
  );

  it(
    "runs what it was allowed, with no sandbox of its own to fail inside the sandbox",
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
      expect(offered()).toContain("Bash");
      expect(offered()).not.toContain("EnterPlanMode");
      expect(offered()).not.toContain("ExitPlanMode");
    },
  );

  it(
    "is offered IdleBiz's skills and none of the founder's, the project's or claude's own, nor their instructions",
    { timeout: 60_000 },
    async () => {
      const { result } = await turn("true", true);
      expect(result.end).toEqual({ kind: "completed" });
      const requests = sent().join("\n");
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
      expect(sent().length).toBeGreaterThan(0);
      for (const request of sent()) {
        expect(request.split("TEAM_NOTES_MARK")).toHaveLength(2);
        expect(request).toContain("Teammates wrote them, not the founder");
      }
    },
  );

  it("signs in with the env of the founder's settings", { timeout: 60_000 }, async () => {
    await turn("echo sign-in=$IDLEBIZ_GATE_SIGN_IN", true);
    expect(outputs()).toContain("sign-in=from-settings");
  });

  it("asks for the model and effort the founder's settings pick", { timeout: 60_000 }, async () => {
    const { result } = await turn("true", true);
    expect(result.end).toEqual({ kind: "completed" });
    const asked = sent().map((body) => Asked.parse(parseJson(body)));
    expect(asked).not.toEqual([]);
    for (const request of asked) {
      expect(request.model).toMatch(/sonnet/u);
      expect(request.output_config).toEqual({ effort: "low" });
    }
  });

  it("gives its shell commands time to wait out a deploy", { timeout: 60_000 }, async () => {
    await turn("echo timeout=$BASH_DEFAULT_TIMEOUT_MS", true);
    expect(outputs()).toContain(`timeout=${DEPLOY_TIMEOUT_MS + 60_000}`);
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
      const { asks, result } = await turnOf({ file: outside, kind: "read" }, true);
      expect(result.end).toEqual({ kind: "completed" });
      expect(asks).toEqual([{ kind: "read" }]);
      expect(outputs()).toContain("read from outside");
    },
  );

  it("runs each command inside the sandbox", { timeout: 60_000 }, async () => {
    const secrets = path.join(root, "vault.json");
    writeFileSync(secrets, "sandboxed canary");
    writeFileSync(path.join(workspace, "own.txt"), "the run's own");
    await turn(`cat own.txt; cat ${secrets}`, true);
    const output = outputs();
    expect(output).toContain("the run's own");
    expect(output).toContain("Operation not permitted");
    expect(output).not.toContain("sandboxed canary");
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
      expect(outputs()).toMatch(/operation not permitted/iu);
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
      expect(outputs()).toMatch(/operation not permitted/iu);
      expect(readFileSync(account, "utf-8")).toBe(before);
      const cwd = await realPathOf(workspace);
      const project = path.join(configDir, "projects", cwd.replaceAll(/[^a-zA-Z0-9]/gu, "-"));
      expect(readdirSync(project).some((file) => file.endsWith(".jsonl"))).toBe(true);
    },
  );
});
