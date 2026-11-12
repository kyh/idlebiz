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
import type { ToolAsk } from "@repo/agent-driver/tool-ask";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readTeamNotes } from "./team-notes";
import { acpAgentFor, codexSessionEnv } from "./session";
import { machineSeal } from "./machine-seal";
import { sealRuns } from "./seal-check";
import { tempSave } from "../test-support/save";
import { startStandInModel } from "../test-support/stand-in-model";
import type { Move, StandInModel } from "../test-support/stand-in-model";

// The real codex, driven through the app's codex-acp inside the seal, by the stand-in model on
// loopback (test-support/stand-in-model.ts): nothing is billed, and codex's home is a scratch
// one. It proves codex, whose own sandbox is off, asks IdleBiz nothing and runs each command inside
// the seal, loads no rule of the founder's, starts no MCP server of theirs,
// offers the model IdleBiz's skills and none of the founder's (their plugins' included), nor
// their instructions or memories, but the workspace's AGENTS.md once, whole, and picked as main
// picks it for a claude run, leaves no skill for a later run, and runs, but cannot rewrite, the
// config their own codex loads.

const root = tempSave();

const codexRuns =
  process.platform === "darwin" && spawnSync(runnerBin("codex"), ["--version"]).status === 0;

/** What every turn's prompt carries, so the stand-in answers it with the turn's move. */
const TURN = "CODEX-GATE";

/** Where `name` is described as `marker`, for a request that lists it to be found by. */
const plantSkill = (skills: string, name: string, marker: string): void => {
  mkdirSync(path.join(skills, name), { recursive: true });
  writeFileSync(
    path.join(skills, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${marker}. Use it for any work at all.\n---\n\n${marker}\n`,
  );
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

describe.skipIf(!codexRuns)("codex inside the seal", () => {
  let model: StandInModel;
  let base = "";
  let skills = "";
  let home = "";
  let codexHome = "";
  let workspace = "";
  let remote = "";

  beforeAll(async () => {
    model = await startStandInModel();
  });

  afterAll(async () => {
    await model.close();
  });

  /** Each request codex sent, whole. */
  const sent = () =>
    model.requests.filter(({ protocol }) => protocol === "responses").map(({ body }) => body);

  beforeEach(() => {
    model.reset();
    base = mkdtempSync(path.join(tmpdir(), "idlebiz-codex-run-"));
    // IdleBiz's skills as shipped, and one more
    skills = path.join(base, "skills");
    cpSync(path.resolve(import.meta.dirname, "../../../resources/skills"), skills, {
      recursive: true,
    });
    plantSkill(path.join(skills, ".agents", "skills"), "bundled-gate", "BUNDLED_SKILL_MARK");
    home = path.join(base, "home");
    // where the founder's codex keeps its config, so the seal treats it as theirs
    codexHome = path.join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'model = "gpt-5.4"',
        'model_provider = "stand-in"',
        // notes a claude run would not be handed: another file's, or fewer bytes of AGENTS.md
        'project_doc_fallback_filenames = ["CLAUDE.md"]',
        "project_doc_max_bytes = 4",
        "[model_providers.stand-in]",
        'name = "stand-in"',
        `base_url = "${model.url}/v1"`,
        'wire_api = "responses"',
        // a server of the founder's, which leaves a mark if a run starts it
        "[mcp_servers.founder]",
        'command = "/bin/sh"',
        `args = ["-c", "touch ${path.join(base, "mcp-started")}; exec cat"]`,
        '[plugins."founder-plugin@founder-market"]',
        "enabled = true",
        "[features]",
        "memories = true",
      ].join("\n"),
    );
    // every place codex loads the founder's own skills from: theirs, and an enabled plugin's
    plantSkill(path.join(codexHome, "skills"), "founder-gate", "FOUNDER_SKILL_MARK");
    plantSkill(path.join(home, ".agents", "skills"), "founder-agents-gate", "FOUNDER_AGENTS_MARK");
    const plugin = path.join(
      codexHome,
      "plugins",
      "cache",
      "founder-market",
      "founder-plugin",
      "1",
    );
    mkdirSync(path.join(plugin, ".codex-plugin"), { recursive: true });
    writeFileSync(path.join(plugin, ".codex-plugin", "plugin.json"), '{"name":"founder-plugin"}');
    plantSkill(path.join(plugin, "skills"), "plugin-gate", "FOUNDER_PLUGIN_MARK");
    // their instructions, and what their own sessions left in codex's memory
    writeFileSync(path.join(codexHome, "AGENTS.md"), "FOUNDER_INSTRUCTIONS_MARK\n");
    mkdirSync(path.join(codexHome, "memories"));
    writeFileSync(path.join(codexHome, "memories", "memory_summary.md"), "FOUNDER_MEMORY_MARK\n");
    // a rule of theirs, which no run loads
    mkdirSync(path.join(codexHome, "rules"));
    writeFileSync(
      path.join(codexHome, "rules", "default.rules"),
      'prefix_rule(pattern=["git", "push"], decision="allow")\n',
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

  /** One turn of `next`, and every ask it raised. */
  const turn = async (next: Move) => {
    model.script(TURN, [next]);
    const state = await sealRuns();
    if (state.kind !== "sealed") {
      throw new Error(state.reason);
    }
    const asks: ToolAsk[] = [];
    const agent = await asFounderAt(home, async () => {
      const seal = await machineSeal([workspace]);
      const setup = { skills, teamNotes: null, userSettings: {} };
      return acpAgentFor(
        "codex",
        seal,
        setup,
        await codexSessionEnv(seal, { CODEX_HOME: codexHome }),
      );
    });
    const result = await runAcpTurn({
      agent,
      cwd: workspace,
      env: { CODEX_HOME: codexHome },
      idleTimeoutMs: 60_000,
      maxSessionMs: 90_000,
      onEvent: () => {},
      onPermission: (tool) => {
        asks.push(tool);
        return Promise.resolve({ allow: false });
      },
      prompt: () => `${TURN} work`,
      teardownGraceMs: 500,
    });
    const pushed = execFileSync("git", ["for-each-ref"], { cwd: remote }).toString();
    return { asks, mcpStarted: existsSync(path.join(base, "mcp-started")), pushed, result };
  };

  it(
    "runs a command asking IdleBiz nothing, with no sandbox of its own to fail inside the seal",
    { timeout: 60_000 },
    async () => {
      const { asks, pushed, result } = await turn({
        command: "git push origin main",
        kind: "shell",
      });
      expect(result.end).toEqual({ kind: "completed" });
      expect(asks).toEqual([]);
      expect(pushed).toContain("refs/heads/main");
    },
  );

  it("starts none of the founder's MCP servers", { timeout: 60_000 }, async () => {
    const { mcpStarted, result } = await turn({ command: "true", kind: "shell" });
    expect(result.end).toEqual({ kind: "completed" });
    expect(mcpStarted).toBe(false);
  });

  it(
    "is offered IdleBiz's skills and none of the founder's, their plugins', instructions or memories",
    { timeout: 60_000 },
    async () => {
      const { result } = await turn({ command: "true", kind: "shell" });
      expect(result.end).toEqual({ kind: "completed" });
      const requests = sent().join("\n");
      for (const name of readdirSync(path.join(skills, ".agents", "skills"))) {
        expect(requests).toContain(name);
      }
      expect(requests).toContain("BUNDLED_SKILL_MARK");
      for (const mark of [
        "FOUNDER_SKILL_MARK",
        "FOUNDER_AGENTS_MARK",
        "FOUNDER_PLUGIN_MARK",
        "FOUNDER_INSTRUCTIONS_MARK",
        "FOUNDER_MEMORY_MARK",
      ]) {
        expect(requests).not.toContain(mark);
      }
    },
  );

  it(
    "reads the notes the team keeps in the workspace's AGENTS.md itself, once, whole, as a claude run is handed them",
    { timeout: 60_000 },
    async () => {
      writeFileSync(path.join(workspace, "AGENTS.md"), "TEAM_NOTES_MARK\n");
      const { result } = await turn({ command: "true", kind: "shell" });
      expect(result.end).toEqual({ kind: "completed" });
      expect(sent().length).toBeGreaterThan(0);
      for (const request of sent()) {
        expect(request.split("TEAM_NOTES_MARK")).toHaveLength(2);
      }
    },
  );

  it(
    "reads AGENTS.override.md in AGENTS.md's place, as main picks for a claude run, and no CLAUDE.md the founder's config falls back to",
    { timeout: 120_000 },
    async () => {
      writeFileSync(path.join(workspace, "CLAUDE.md"), "CLAUDE_MD_MARK\n");
      await turn({ command: "true", kind: "shell" });
      expect(sent().length).toBeGreaterThan(0);
      expect(sent().join("\n")).not.toContain("CLAUDE_MD_MARK");
      model.reset();
      writeFileSync(path.join(workspace, "AGENTS.md"), "TEAM_NOTES_MARK\n");
      writeFileSync(path.join(workspace, "AGENTS.override.md"), "OVERRIDE_MARK\n");
      const { result } = await turn({ command: "true", kind: "shell" });
      expect(result.end).toEqual({ kind: "completed" });
      expect(sent().length).toBeGreaterThan(0);
      const requests = sent().join("\n");
      expect(requests).toContain("OVERRIDE_MARK");
      expect(requests).not.toContain("TEAM_NOTES_MARK");
      expect(await readTeamNotes(workspace)).toEqual({ cut: false, text: "OVERRIDE_MARK" });
    },
  );

  it("leaves no skill in its workspace for a later run to load", { timeout: 60_000 }, async () => {
    const skill = path.join(workspace, ".agents", "skills", "planted", "SKILL.md");
    const cmd = `touch ran; mkdir -p ${path.dirname(skill)} && echo planted > ${skill}`;
    const { result } = await turn({ command: cmd, kind: "shell" });
    expect(result.end).toEqual({ kind: "completed" });
    expect(existsSync(path.join(workspace, "ran"))).toBe(true);
    expect(existsSync(path.join(workspace, ".agents"))).toBe(false);
  });

  it("runs each command inside the seal", { timeout: 60_000 }, async () => {
    const secrets = path.join(root, "secrets.json");
    writeFileSync(secrets, "sealed canary");
    const outside = path.join(root, "outside.txt");
    const cmd = `cat ${secrets} > read.txt; echo x > ${outside}; touch ran`;
    const { result } = await turn({ command: cmd, kind: "shell" });
    expect(result.end).toEqual({ kind: "completed" });
    expect(existsSync(path.join(workspace, "ran"))).toBe(true);
    expect(readFileSync(path.join(workspace, "read.txt"), "utf-8")).toBe("");
    expect(existsSync(outside)).toBe(false);
  });

  it(
    "makes a patch asking nothing, and the seal refuses one that moves a file into the save",
    { timeout: 60_000 },
    async () => {
      const approvals = path.join(root, "company", "approvals.json");
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
      const { asks } = await turn({ kind: "patch", patch });
      expect(asks).toEqual([]);
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
      const { result } = await turn({ command: cmd, kind: "shell" });
      expect(result.end).toEqual({ kind: "completed" });
      expect(existsSync(path.join(workspace, "ran"))).toBe(true);
      expect(readFileSync(config, "utf-8")).toBe(before);
      expect(existsSync(script)).toBe(false);
    },
  );
});
