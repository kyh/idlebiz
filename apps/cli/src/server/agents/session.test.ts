import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LivePage } from "../policy/browser";
import type { BlockedAsk } from "@repo/domain/domain";
import { parseJson } from "@repo/domain/json";
import { RefusalError } from "../refusal";
import { DEPLOY_TIMEOUT_MS } from "../tool-specs";
import type { Seal } from "./seal";
import { TEAM_NOTES_MAX_BYTES } from "./team-notes";

const { SEAL, SKILLS, found, root } = await import("./fixtures");
const store = await import("../store/store");
const { acpAgentFor, codexSessionConfig, codexSessionEnv, decidePermission } =
  await import("./session");
const { createAgentDriver } = await import("./runner-pool");
const { browserNamespace, realPathOf, sealedCommand } = await import("./seal");

const SETUP = { skills: SKILLS, teamNotes: null, userSettings: {} };

const noPage: LivePage = () => Promise.resolve(null);

describe("decidePermission", () => {
  const push = { tool: { command: "git push", kind: "shell" } } as const;
  const workspace = path.join(root, "acme", "workspace");
  const room = { cwd: workspace, real: realPathOf, writable: [workspace] };

  /** A company whose founder signed for one `git push` on task "deploy". */
  const signedFor = () => {
    found();
    store.grantApproval("deploy", "git push");
    const asked: BlockedAsk[] = [];
    const decide = (signal: AbortSignal) =>
      decidePermission("deploy", push, new Set(), noPage, room, (ask) => asked.push(ask), signal);
    return { asked, decide };
  };

  it("spends the sign-off on a live turn", async () => {
    const { asked, decide } = signedFor();
    expect(await decide(new AbortController().signal)).toEqual({ allow: true });
    expect(store.consumeApproval("deploy", "git push")).toBe(false);
    expect(asked).toEqual([]);
  });

  it.each([
    { key: "mcp: use gmail", leased: true, tool: { kind: "mcp", server: "gmail" } },
    { key: "git push", leased: false, tool: push.tool },
  ] as const)("leases a sign-off for the run only when its rule says so: $key", async (signed) => {
    found();
    store.grantApproval("deploy", signed.key);
    const leases = new Set<string>();
    const decision = await decidePermission(
      "deploy",
      { tool: signed.tool },
      leases,
      noPage,
      room,
      () => null,
      new AbortController().signal,
    );
    expect(decision).toEqual({ allow: true });
    expect(leases.has(signed.key)).toBe(signed.leased);
  });

  it.each([
    { allow: true, tool: { kind: "edit" } },
    { allow: false, tool: { kind: "sandbox" } },
  ] as const)(
    "answers a $tool.kind ask with no card: the seal judges edits, and no widening is signed",
    async ({ allow, tool }) => {
      found();
      const asked: BlockedAsk[] = [];
      const decision = await decidePermission(
        "deploy",
        { tool },
        new Set(),
        noPage,
        room,
        (ask) => asked.push(ask),
        new AbortController().signal,
      );
      expect(decision).toEqual({ allow });
      expect(asked).toEqual([]);
    },
  );

  it("holds a file the run linked in from outside, judged where the link leads", async () => {
    found();
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "index.html"), "own");
    writeFileSync(path.join(root, "outside.html"), "outside");
    symlinkSync(path.join(root, "outside.html"), path.join(workspace, "linked.html"));
    const asked: BlockedAsk[] = [];
    const open = (file: string) =>
      decidePermission(
        "qa",
        {
          tool: {
            command: `agent-browser open file://${path.join(workspace, file)}`,
            kind: "shell",
          },
        },
        new Set(),
        noPage,
        room,
        (ask) => asked.push(ask),
        new AbortController().signal,
      );
    expect(await open("index.html")).toEqual({ allow: true });
    expect(await open("linked.html")).toEqual({ allow: false });
    expect(asked).toEqual([
      {
        command: `agent-browser open file://${path.join(workspace, "linked.html")}`,
        rule: "browser-file",
        type: "approval",
      },
    ]);
  });

  it("neither spends the sign-off nor asks the founder for a turn that has ended", async () => {
    const { asked, decide } = signedFor();
    expect(await decide(AbortSignal.abort())).toEqual({ allow: false });
    expect(asked).toEqual([]);
    expect(store.consumeApproval("deploy", "git push")).toBe(true);
  });
});

describe("acpAgentFor", () => {
  it.each([
    ["claude", "claude-agent-acp"],
    ["codex", "codex-acp"],
  ] as const)("starts a %s session inside that runner's seal", (runner, adapter) => {
    const { command } = acpAgentFor(runner, SEAL, SETUP);
    expect(command.slice(0, -2)).toEqual(sealedCommand(SEAL, runner, []));
    expect(command.slice(-2)).toEqual([process.execPath, expect.stringContaining(adapter)]);
  });

  it("starts agent-browser's Chrome without a sandbox of its own, in the daemons of its runner and folders", () => {
    const codex = acpAgentFor("codex", SEAL, SETUP).env;
    const claude = acpAgentFor("claude", SEAL, SETUP).env;
    expect(codex.AGENT_BROWSER_ARGS).toBe("--no-sandbox");
    expect(codex.AGENT_BROWSER_NAMESPACE).toBe("idlebiz-x");
    expect(claude.AGENT_BROWSER_NAMESPACE).toBe("idlebiz-c");
    expect(browserNamespace(root, "claude", [])).not.toBe(browserNamespace(root, "codex", []));
    const workspace = path.join(root, "acme/workspace");
    expect(browserNamespace(root, "claude", [workspace])).not.toBe(
      browserNamespace(root, "claude", [path.join(root, "acme/products/b/workspace")]),
    );
    expect(codex.AGENT_BROWSER_SOCKET_DIR).toBe(path.join(homedir(), ".agent-browser"));
  });

  it("saves a screenshot named no path in the runs' temp folder, which a run writes", () => {
    expect(acpAgentFor("claude", SEAL, SETUP).env.AGENT_BROWSER_SCREENSHOT_DIR).toBe(
      path.join(root, "cache", "tmp", "screenshots"),
    );
  });

  it("runs codex in the mode that asks for everything and sandboxes nothing itself", () => {
    expect(acpAgentFor("codex", SEAL, SETUP).sessionModeId).toBe("external-sandbox");
  });

  it("loads none of the founder's MCP servers or claude.ai connectors into a claude session", () => {
    expect(acpAgentFor("claude", SEAL, SETUP).sessionMeta).toMatchObject({
      claudeCode: {
        options: {
          settings: {
            disableClaudeAiConnectors: true,
            permissions: { deny: ["mcp__*", "EnterPlanMode", "ExitPlanMode"] },
          },
          strictMcpConfig: true,
        },
      },
    });
  });

  it("hands codex the founder's MCP servers, plugins and memories to turn off, and the notes a claude run reads", () => {
    const off = codexSessionConfig('[{"name":"gmail","enabled":true},{"name":"linear"}]');
    expect(parseJson(off.CODEX_CONFIG)).toEqual({
      features: { apps: false, memories: false, plugins: false },
      mcp_servers: { gmail: { enabled: false }, linear: { enabled: false } },
      project_doc_fallback_filenames: [],
      project_doc_max_bytes: TEAM_NOTES_MAX_BYTES,
    });
    expect(acpAgentFor("codex", SEAL, SETUP, off).env).toMatchObject(off);
  });

  it("starts no codex run whose MCP servers it could not list, and says why", async () => {
    expect(() => codexSessionConfig("Error: unknown flag --json")).toThrow(RefusalError);
    vi.stubEnv("CODEX_BIN", path.join(root, "no-codex"));
    try {
      await expect(codexSessionEnv(SEAL)).rejects.toThrow(
        /could not list your codex MCP servers to keep them out of the run \(.+\)/u,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets a claude shell command run as long as a deploy may take to answer", () => {
    const { BASH_DEFAULT_TIMEOUT_MS: timeout } = acpAgentFor("claude", SEAL, SETUP).env;
    expect(Number(timeout)).toBeGreaterThan(DEPLOY_TIMEOUT_MS);
  });

  it("loads IdleBiz's skills into a claude session, and no settings, skills or plugins of the founder's or claude's own", () => {
    const { readDirs, sessionMeta } = acpAgentFor("claude", SEAL, SETUP);
    expect(sessionMeta).toMatchObject({
      claudeCode: {
        options: {
          plugins: [{ path: path.join(SKILLS, ".agents"), type: "local" }],
          settingSources: [],
          settings: { disableBundledSkills: true },
        },
      },
    });
    expect(readDirs).toEqual([]);
  });

  it("hands a codex session IdleBiz's skills to read, beside the run's own folders", () => {
    const { readDirs, sessionMeta } = acpAgentFor("codex", SEAL, SETUP);
    expect(readDirs).toEqual([SKILLS]);
    expect(sessionMeta).toBeUndefined();
  });

  it("hands the team's notes to a claude session beside its system prompt, and none to codex, which reads them itself", () => {
    const setup = { ...SETUP, teamNotes: "# Team notes" };
    expect(acpAgentFor("claude", SEAL, setup).sessionMeta).toMatchObject({
      systemPrompt: { append: "# Team notes" },
    });
    expect(acpAgentFor("claude", SEAL, SETUP).sessionMeta).not.toHaveProperty("systemPrompt");
    expect(acpAgentFor("codex", SEAL, setup).sessionMeta).toBeUndefined();
  });

  it("signs a claude session in, and picks its model, as the founder's settings did", () => {
    const userSettings = { apiKeyHelper: "~/bin/anthropic-key", model: "haiku" };
    const agent = acpAgentFor(
      "claude",
      SEAL,
      { skills: SKILLS, teamNotes: null, userSettings },
      {
        AGENT_BROWSER_ARGS: "",
        ANTHROPIC_BASE_URL: "https://gateway.example.com",
      },
    );
    expect(agent.sessionMeta).toMatchObject({
      claudeCode: {
        options: {
          settings: {
            apiKeyHelper: "~/bin/anthropic-key",
            model: "haiku",
            permissions: { ask: ["Bash", "Edit", "Write", "NotebookEdit"] },
            sandbox: { enabled: false },
          },
        },
      },
    });
    expect(agent.env.ANTHROPIC_BASE_URL).toBe("https://gateway.example.com");
    expect(agent.env.AGENT_BROWSER_ARGS).toBe("--no-sandbox");
  });

  it("keeps claude's own sandbox off, whatever the founder's settings say", () => {
    expect(acpAgentFor("claude", SEAL, SETUP).sessionMeta).toMatchObject({
      claudeCode: { options: { settings: { sandbox: { enabled: false } } } },
    });
  });
});

const onMac = process.platform === "darwin";

/** An ACP agent whose one message is the names of the variables it was started with. */
const ENV_NAMING_AGENT = `
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { agentCapabilities: {}, protocolVersion: 1 } });
  if (method === "session/new") send({ id, result: { sessionId: "s1" } });
  if (method === "session/set_mode") send({ id, result: {} });
  if (method === "session/prompt") {
    const content = { text: JSON.stringify(Object.keys(process.env)), type: "text" };
    send({ method: "session/update", params: { sessionId: "s1", update: { content, sessionUpdate: "agent_message_chunk" } } });
    send({ id, result: { stopReason: "end_turn" } });
  }
});
`;

describe("the environment an agent is spawned with", () => {
  const founder = {
    ANTHROPIC_API_KEY: "sk-ant-founder",
    STRIPE_SECRET_KEY: "sk_live_founder",
    VERCEL_TOKEN: "vercel-founder",
  };
  const touched = [...Object.keys(founder), "CLAUDE_BIN", "CODEX_BIN"];
  const previous = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  const names = z.array(z.string());
  let cwd = "";

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "idlebiz-run-env-"));
    Object.assign(process.env, founder);
  });

  afterEach(() => {
    rmSync(cwd, { force: true, recursive: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("holds none of IdleBiz's keys, even when main's own env has them", async () => {
    const agent = acpAgentFor("claude", SEAL, SETUP);
    const { end, summary } = await runAcpTurn({
      agent: { ...agent, command: [process.execPath, "-e", ENV_NAMING_AGENT] },
      cwd,
      env: { IDLEBIZ_RUN_TOKEN: "run" },
      idleTimeoutMs: 0,
      maxSessionMs: 0,
      onEvent: () => {},
      prompt: "work",
      systemPrompt: "",
      teardownGraceMs: 100,
    });
    expect(end).toEqual({ kind: "completed" });
    const spawnedWith = names.parse(parseJson(summary));
    expect(spawnedWith).not.toContain("VERCEL_TOKEN");
    expect(spawnedWith).not.toContain("STRIPE_SECRET_KEY");
    expect(spawnedWith).toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY", "IDLEBIZ_RUN_TOKEN", "PATH"]),
    );
  });

  it.skipIf(!onMac)("probes a CLI's login in the env its runs get", async () => {
    const seen = path.join(cwd, "seen.json");
    const cli = path.join(cwd, "claude");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env)));`;
    writeFileSync(cli, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
    process.env.CLAUDE_BIN = cli;
    process.env.CODEX_BIN = path.join(cwd, "no-codex");

    // the stand-in CLI writes what it saw where a run may write
    const scratch: Seal["scratch"][number] = { match: "subpath", path: realpathSync(cwd) };
    const driver = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      () => Promise.resolve({ ...SEAL, scratch: [scratch] }),
    );
    driver.init();
    await driver.hasAnyRunner();
    const probedWith = names.parse(parseJson(readFileSync(seen, "utf-8")));
    expect(probedWith).not.toContain("VERCEL_TOKEN");
    expect(probedWith).toContain("ANTHROPIC_API_KEY");
  });
});
