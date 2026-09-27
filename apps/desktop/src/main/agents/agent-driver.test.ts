import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import { addUsage, zeroUsage } from "@repo/agent-driver/events";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LivePage } from "@/shared/command-policy";
import type { AuthFlowEvent, BlockedAsk } from "@/shared/domain";
import { parseJson } from "@/shared/json";
import { RefusalError } from "@/shared/refusal";
import { DEPLOY_TIMEOUT_MS } from "@/shared/tool-specs";
import type { BrowserCli } from "./agent-driver";
import type { Seal, SealState } from "./seal";

const execFileAsync = promisify(execFile);
const root = mkdtempSync(path.join(tmpdir(), "idlebiz-driver-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const store = await import("@/main/store/store");
const {
  PAGE_URLS,
  acpAgentFor,
  agentDriver,
  askBox,
  codexMcpOff,
  createAgentDriver,
  decidePermission,
  ensureRepository,
  gitIdentity,
  livePageOf,
  mcpOffConfig,
  memoryAfter,
  outcomeOf,
  resumeIn,
} = await import("./agent-driver");
const { browserNamespace, realPathOf, sealedCommand, signInCommand } = await import("./seal");
const { startLogin } = await import("./onboarding");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

const SEAL: Seal = {
  claudeProjects: { own: null, projects: "/Users/me/.claude/projects" },
  debugPorts: [9222],
  namespaces: {
    claude: { match: "subpath", path: "/Users/me/.agent-browser/namespaces/idlebiz-c" },
    codex: { match: "subpath", path: "/Users/me/.agent-browser/namespaces/idlebiz-x" },
  },
  preferences: "/Users/me/Library/Preferences",
  runners: {
    claude: {
      account: [{ match: "prefix", path: "/Users/me/.claude.json" }],
      folder: "/Users/me/.claude",
      home: [{ match: "subpath", path: "/Users/me/.claude" }],
      state: [{ match: "subpath", path: "/Users/me/.claude/sessions" }],
    },
    codex: {
      account: [],
      folder: "/Users/me/.codex",
      home: [{ match: "subpath", path: "/Users/me/.codex" }],
      state: [{ match: "prefix", path: "/Users/me/.codex/auth.json" }],
    },
  },
  runsAsFounder: [],
  save: [{ match: "subpath", path: "/Users/me/.idlebiz" }],
  scratch: [{ match: "subpath", path: "/private/tmp" }],
  sockets: [{ match: "subpath", path: "/private/var/run/com.apple.launchd.x/Listeners" }],
  unreadable: [{ match: "prefix", path: "/Users/me/.idlebiz/secrets.json" }],
  writable: [{ match: "subpath", path: "/Users/me/.idlebiz/acme/workspace" }],
};

const failed = { error: "exceeded the 45m session limit — killed", kind: "failed" } as const;
const limited = { error: "You've hit your session limit", kind: "limited", resetsAt: 99 } as const;

describe("addUsage", () => {
  it("counts both attempts of a retried turn, dollars as already priced", () => {
    const stale = { cachedTokens: 1, costUsd: 0.02, inputTokens: 10, outputTokens: 0 };
    const fresh = { cachedTokens: 5, costUsd: 0.5, inputTokens: 200, outputTokens: 40 };
    expect(addUsage(stale, fresh)).toEqual({
      cachedTokens: 6,
      costUsd: 0.52,
      inputTokens: 210,
      outputTokens: 40,
    });
    expect(addUsage(zeroUsage(), fresh)).toEqual(fresh);
  });
});

describe("outcomeOf", () => {
  it("is done when the turn completed with nothing asked", () => {
    expect(outcomeOf({ kind: "completed" }, null, false)).toEqual({ kind: "done" });
  });

  it("waits on the founder whenever something was asked, however the turn ended", () => {
    const ask = { question: "Ship it?", type: "question" } as const;
    expect(outcomeOf(limited, ask, false)).toEqual({ ask, kind: "blocked" });
    expect(outcomeOf(failed, ask, true)).toEqual({ ask, kind: "blocked" });
  });

  it("rests only when the agent refused the turn for a limit, whatever a failure says", () => {
    expect(outcomeOf(limited, null, false)).toEqual({
      error: limited.error,
      kind: "resting",
      until: 99,
    });
    expect(outcomeOf(failed, null, false)).toEqual({ error: failed.error, kind: "failed" });
  });

  it("parks the task, burning no attempt, when the runner's login was refused", () => {
    const signedOut = { error: "Failed to authenticate", kind: "signedOut" } as const;
    expect(outcomeOf(signedOut, null, false)).toEqual({
      error: "Failed to authenticate",
      kind: "signedOut",
    });
    expect(outcomeOf(signedOut, null, true)).toEqual({ kind: "interrupted" });
  });

  it("does not hold the task to a turn the app stopped, unless it finished anyway", () => {
    expect(outcomeOf(failed, null, true)).toEqual({ kind: "interrupted" });
    expect(outcomeOf({ kind: "completed" }, null, true)).toEqual({ kind: "done" });
  });
});

/** A window as the page walk reads it; one of another origin throws on `location`. */
interface FakeWindow {
  readonly [index: number]: FakeWindow;
  readonly length: number;
  readonly location: { href: string };
  readonly document?: FakeRoot;
  readonly performance?: {
    getEntriesByType: () => readonly { initiatorType: string; name: string }[];
  };
}

interface FakeRoot {
  /** Every element under it, as `querySelectorAll("*")` returns them. */
  querySelectorAll: () => readonly FakeElement[];
}

interface FakeElement {
  contentWindow: FakeWindow | null;
  shadowRoot: FakeRoot | null;
}

interface FakeParts {
  /** What `window.frames` lists. */
  frames?: FakeWindow[];
  elements?: FakeElement[];
  /** What the page's own script left in `window.length`, if it shadowed it. */
  length?: number;
  /** The URLs its frames were loaded from, as resource timing names them. */
  loaded?: string[];
}

const ownWindow = (href: string, parts: FakeParts = {}): FakeWindow => ({
  ...Object.fromEntries((parts.frames ?? []).entries()),
  document: { querySelectorAll: () => parts.elements ?? [] },
  length: parts.length ?? (parts.frames ?? []).length,
  location: { href },
  performance: {
    getEntriesByType: () => [
      { initiatorType: "script", name: `${href}app.js` },
      ...(parts.loaded ?? []).map((name) => ({ initiatorType: "iframe", name })),
    ],
  },
});

const foreignWindow = (): FakeWindow => ({
  length: 0,
  get location(): never {
    throw new Error("SecurityError: Blocked a frame from accessing a cross-origin frame.");
  },
});

const iframe = (contentWindow: FakeWindow): FakeElement => ({ contentWindow, shadowRoot: null });

const shadowHost = (elements: FakeElement[]): FakeElement => ({
  contentWindow: null,
  shadowRoot: { querySelectorAll: () => elements },
});

const PageUrls = z.array(z.string().nullable());

const pageUrlsOf = (top: FakeWindow): readonly (string | null)[] =>
  PageUrls.parse(runInNewContext(PAGE_URLS, { window: { top } }));

describe("PAGE_URLS", () => {
  it("finds frames in open shadow roots and those a page's own `length` hides", () => {
    const embed = ownWindow("http://localhost:3000/embed");
    const top = ownWindow("http://localhost:3000/", {
      elements: [iframe(embed), shadowHost([iframe(foreignWindow())])],
      length: 0,
    });
    expect(pageUrlsOf(top)).toEqual([
      "http://localhost:3000/",
      "http://localhost:3000/embed",
      null,
    ]);
  });

  it("names a frame no script can reach by the URL it was loaded from", () => {
    const top = ownWindow("http://localhost:3000/", { loaded: ["http://localhost:4000/pay"] });
    expect(pageUrlsOf(top)).toEqual(["http://localhost:3000/", "http://localhost:4000/pay"]);
  });

  it("reads a frame once, however it is reached", () => {
    const embed = ownWindow("http://localhost:3000/embed");
    const top = ownWindow("http://localhost:3000/", {
      elements: [iframe(embed)],
      frames: [embed],
    });
    expect(pageUrlsOf(top)).toEqual(["http://localhost:3000/", "http://localhost:3000/embed"]);
  });
});

describe("a limit a turn hit", () => {
  it("parks a runner until its limit lifts, and only that runner", () => {
    const until = Date.now() + 60_000;
    agentDriver.heed("claude", { ...limited, resetsAt: until });
    expect(agentDriver.restingRunner("claude")).toBe(until);
    expect(agentDriver.restingRunner("codex")).toBeNull();
    expect(agentDriver.restingRunners()).toEqual({ claude: until });
  });

  it("wakes a runner once its limit has lifted", () => {
    agentDriver.heed("codex", { ...limited, resetsAt: Date.now() - 1 });
    expect(agentDriver.restingRunner("codex")).toBeNull();
    expect(agentDriver.restingRunners()).not.toHaveProperty("codex");
  });
});

describe("memoryAfter", () => {
  const kept = { id: "kept", workspace: "/save/workspace" };
  const stored = { instructionsDigest: "old", session: kept };
  const ran = { id: "ran", workspace: "/save/products/b/workspace" };

  it("remembers the session the turn ran, where it ran, holding the instructions it was given", () => {
    expect(
      memoryAfter({ end: { kind: "completed" }, sessionId: "ran" }, stored, "new", ran.workspace),
    ).toEqual({ instructionsDigest: "new", session: ran });
    expect(memoryAfter({ end: failed, sessionId: "ran" }, stored, "new", ran.workspace)).toEqual({
      instructionsDigest: "new",
      session: ran,
    });
  });

  it("leaves what was stored when the turn opened no session", () => {
    expect(memoryAfter({ end: failed }, stored, "new", ran.workspace)).toEqual(stored);
  });

  it("forgets a session only a new one can follow", () => {
    const spent = { error: "context window exceeded", kind: "failed", sessionSpent: true } as const;
    expect(memoryAfter({ end: spent, sessionId: "kept" }, stored, "new", kept.workspace)).toEqual({
      instructionsDigest: null,
      session: null,
    });
  });
});

describe("resumeIn", () => {
  const session = { id: "s1", workspace: "/save/products/a/workspace" };

  it("resumes a session in the folder it began in", () => {
    expect(resumeIn(session, "/save/products/a/workspace")).toBe("s1");
  });

  it("starts fresh in any other folder, where claude could not record the turn", () => {
    expect(resumeIn(session, "/save/products/b/workspace")).toBeUndefined();
    expect(resumeIn(null, "/save/products/a/workspace")).toBeUndefined();
  });
});

const found = () =>
  store.foundCompany({
    budget: { mode: "infinite" },
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [
      {
        name: "Mae",
        persona: "ships",
        role: "engineer",
        runner: "claude",
        spriteSeed: "Mae",
        title: "General Manager",
      },
    ],
    mission: "ship",
    name: "Acme",
  });

const noPage: LivePage = () => Promise.resolve(null);

describe("decidePermission", () => {
  const push = { tool: { command: "git push", kind: "shell" } } as const;
  const workspace = path.join(root, "acme", "workspace");
  const room = { cwd: workspace, real: realPathOf, writable: [workspace] };

  /** A company whose founder signed for one `git push` on task "deploy". */
  const signedFor = () => {
    const company = found();
    store.grantApproval("deploy", "git push");
    const asked: BlockedAsk[] = [];
    const decide = (signal: AbortSignal) =>
      decidePermission(
        { companyId: company.id, id: "deploy" },
        push,
        new Set(),
        noPage,
        room,
        (ask) => asked.push(ask),
        signal,
      );
    return { asked, decide };
  };

  it("spends the sign-off on a live turn", async () => {
    const { asked, decide } = signedFor();
    expect(await decide(new AbortController().signal)).toEqual({ allow: true });
    expect(store.consumeApproval("deploy", "git push")).toBe(false);
    expect(asked).toEqual([]);
  });

  it.each([
    { allow: true, tool: { kind: "edit" } },
    { allow: false, tool: { kind: "sandbox" } },
  ] as const)(
    "answers a $tool.kind ask with no card: the seal judges edits, and no widening is signed",
    async ({ allow, tool }) => {
      const company = found();
      const asked: BlockedAsk[] = [];
      const decision = await decidePermission(
        { companyId: company.id, id: "deploy" },
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
    const company = found();
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "index.html"), "own");
    writeFileSync(path.join(root, "outside.html"), "outside");
    symlinkSync(path.join(root, "outside.html"), path.join(workspace, "linked.html"));
    const asked: BlockedAsk[] = [];
    const open = (file: string) =>
      decidePermission(
        { companyId: company.id, id: "qa" },
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
    const { command } = acpAgentFor(runner, SEAL);
    expect(command.slice(0, -2)).toEqual(sealedCommand(SEAL, runner, []));
    expect(command.slice(-2)).toEqual([process.execPath, expect.stringContaining(adapter)]);
  });

  it("starts agent-browser's Chrome without a sandbox of its own, in its runner's own daemons", () => {
    const codex = acpAgentFor("codex", SEAL).env;
    const claude = acpAgentFor("claude", SEAL).env;
    expect(codex.AGENT_BROWSER_ARGS).toBe("--no-sandbox");
    expect(codex.AGENT_BROWSER_NAMESPACE).toBe(browserNamespace(root, "codex"));
    expect(claude.AGENT_BROWSER_NAMESPACE).toBe(browserNamespace(root, "claude"));
    expect(browserNamespace(root, "claude")).not.toBe(browserNamespace(root, "codex"));
    expect(codex.AGENT_BROWSER_SOCKET_DIR).toBe(path.join(homedir(), ".agent-browser"));
  });

  it("runs codex in the mode that asks for everything and sandboxes nothing itself", () => {
    expect(acpAgentFor("codex", SEAL).sessionModeId).toBe("external-sandbox");
  });

  it("loads none of the founder's MCP servers or claude.ai connectors into a claude session", () => {
    expect(acpAgentFor("claude", SEAL).sessionMeta).toMatchObject({
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

  it("hands codex the founder's MCP servers to turn off", () => {
    const off = mcpOffConfig('[{"name":"gmail","enabled":true},{"name":"linear"}]');
    expect(parseJson(off.CODEX_CONFIG)).toEqual({
      features: { apps: false, plugins: false },
      mcp_servers: { gmail: { enabled: false }, linear: { enabled: false } },
    });
    expect(acpAgentFor("codex", SEAL, off).env).toMatchObject(off);
  });

  it("starts no codex run whose MCP servers it could not list, and says why", async () => {
    expect(() => mcpOffConfig("Error: unknown flag --json")).toThrow(RefusalError);
    vi.stubEnv("CODEX_BIN", path.join(root, "no-codex"));
    try {
      await expect(codexMcpOff(SEAL)).rejects.toThrow(
        /could not list your codex MCP servers to keep them out of the run \(.+\)/u,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lets a claude shell command run as long as a deploy may take to answer", () => {
    const { BASH_DEFAULT_TIMEOUT_MS: timeout } = acpAgentFor("claude", SEAL).env;
    expect(Number(timeout)).toBeGreaterThan(DEPLOY_TIMEOUT_MS);
  });

  it("keeps claude's own sandbox off, whatever the founder's settings say", () => {
    expect(acpAgentFor("claude", SEAL).sessionMeta).toMatchObject({
      claudeCode: { options: { settings: { sandbox: { enabled: false } } } },
    });
  });
});

/** agent-browser as a daemon that is running or not, on the page `urls` names; what it was asked, in order. */
const browserAt = (running: boolean, urls: readonly (string | null)[]) => {
  const asked: string[][] = [];
  const browser: BrowserCli = (args) => {
    asked.push([...args]);
    const data = args.includes("info") ? { active: running } : { result: urls };
    return Promise.resolve(JSON.stringify({ data, success: true }));
  };
  return { asked, browser };
};

describe("livePageOf", () => {
  it("reads the session in the daemon the runs drive", async () => {
    const { asked, browser } = browserAt(true, ["http://localhost:3000/", null]);
    expect(await livePageOf(browser, "idlebiz-x")("mae")).toEqual({
      frames: [null],
      url: "http://localhost:3000/",
    });
    const scope = ["--namespace", "idlebiz-x", "--session", "mae"];
    expect(asked).toEqual([
      [...scope, "session", "info", "--json"],
      [...scope, "eval", PAGE_URLS, "--json"],
    ]);
  });

  it("starts no daemon: a session with none shows no page", async () => {
    const { asked, browser } = browserAt(false, ["about:blank"]);
    expect(await livePageOf(browser, "idlebiz-x")("")).toBeNull();
    expect(asked).toEqual([["--namespace", "idlebiz-x", "session", "info", "--json"]]);
  });

  it("shows no page when agent-browser cannot answer", async () => {
    expect(await livePageOf(() => Promise.reject(new Error("ENOENT")), "idlebiz-x")("")).toBeNull();
  });
});

describe("gitIdentity", () => {
  it("commits as the employee even where the founder signs every commit and tag with keys the seal hides", async () => {
    const company = found();
    const mae = store.listEmployees().find((emp) => emp.name === "Mae");
    if (mae === undefined) {
      throw new Error("no hire founded");
    }
    const workspace = mkdtempSync(path.join(tmpdir(), "idlebiz-sign-"));
    const config = path.join(workspace, "founder.gitconfig");
    writeFileSync(
      config,
      "[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n\tforceSignAnnotated = true\n[gpg]\n\tprogram = /usr/bin/false\n",
    );
    const env = {
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: workspace,
      PATH: "/usr/bin:/bin",
      ...gitIdentity(mae, company),
    };
    const git = (...args: string[]) => execFileAsync("/usr/bin/git", args, { cwd: workspace, env });
    try {
      await git("init", "--quiet");
      await git("commit", "--allow-empty", "--quiet", "-m", "ship");
      await git("tag", "-a", "v1", "-m", "v1");
      const { stdout } = await git("log", "-1", "--format=%an <%ae>");
      expect(stdout.trim()).toBe(`Mae <${mae.id}@${company.id}.idlebiz.invalid>`);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});

describe("ensureRepository", () => {
  it("makes a workspace a repository once, and leaves one that is", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "idlebiz-repo-"));
    try {
      await ensureRepository(workspace);
      expect(existsSync(path.join(workspace, ".git/HEAD"))).toBe(true);
      writeFileSync(path.join(workspace, ".git/HEAD"), "ref: refs/heads/kept\n");
      await ensureRepository(workspace);
      expect(readFileSync(path.join(workspace, ".git/HEAD"), "utf-8")).toBe(
        "ref: refs/heads/kept\n",
      );
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("goes on without one where git cannot make it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(ensureRepository(path.join(root, "no-such-workspace"))).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledWith("[repository]", expect.any(Error));
    } finally {
      logged.mockRestore();
    }
  });
});

/** A claude whose stored login always reads as signed in, and whose sign-in exits `exit`. */
const storedLoginClaude = (exit: number): void => {
  const cli = path.join(root, "claude");
  const script = `case "$1 $2" in --version*) echo 1.0.0 ;; "auth login") exit ${exit} ;; *) echo '{"loggedIn": true}' ;; esac`;
  writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  process.env.CLAUDE_BIN = cli;
};
const signingIn = {
  message: "Signing in to Claude Code — your browser will open…",
  type: "progress",
};

/** Point both CLIs at nothing, so looking for them spawns no real one. */
const withoutClis = () => {
  const touched = ["CLAUDE_BIN", "CODEX_BIN"];
  const previous = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    for (const key of touched) {
      process.env[key] = path.join(root, `no-${key}`);
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
};

describe("a seal the boot check refuses", () => {
  withoutClis();
  const refused: SealState = {
    kind: "refused",
    reason: "sandbox-exec timed out, so none will start.",
  };
  const holding: SealState = { kind: "sealed" };

  it("starts no run and says why, then checks again when the CLIs are looked for again", async () => {
    const verdicts = [refused, holding];
    let checks = 0;
    const driver = createAgentDriver(() => {
      checks += 1;
      return Promise.resolve(verdicts[checks - 1] ?? holding);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      driver.init();
      expect(driver.runsSealed()).toBe(false);
      expect(await driver.sealRefusal()).toBe("sandbox-exec timed out, so none will start.");
      expect(driver.runsSealed()).toBe(false);
      expect(logged).toHaveBeenCalledWith("[seal]", "sandbox-exec timed out, so none will start.");

      await driver.refresh();

      expect(await driver.sealRefusal()).toBeNull();
      expect(driver.runsSealed()).toBe(true);
      await driver.refresh();
      expect(checks).toBe(2);
    } finally {
      logged.mockRestore();
    }
  });
});

const onMac = process.platform === "darwin";

/** Whether a driver whose check holds finds a CLI ready, each probe under the seal `resolveSeal` gives. */
const anyRunnerUnder = async (resolveSeal: () => Promise<Seal>): Promise<boolean> => {
  const driver = createAgentDriver(() => Promise.resolve({ kind: "sealed" }), resolveSeal);
  driver.init();
  return await driver.hasAnyRunner();
};

describe.skipIf(!onMac)("the seal a run starts under", () => {
  withoutClis();
  // a claude that reads as installed only while the canary it tries is sealed from it
  let canary = "";
  beforeEach(() => {
    canary = path.join(realpathSync(root), "canary");
    writeFileSync(canary, "canary");
    const cli = path.join(root, "claude");
    const script = `[ "$1" = --version ] && { cat "${canary}" && exit 3; echo 1.0.0; } || echo '{"loggedIn": true}'`;
    writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.CLAUDE_BIN = cli;
  });
  const sealing = (): Seal => ({ ...SEAL, unreadable: [{ match: "subpath", path: canary }] });

  it("finds a CLI only under its seal, and none with no seal", async () => {
    expect(await anyRunnerUnder(() => Promise.resolve(sealing()))).toBe(true);
    expect(await anyRunnerUnder(() => Promise.resolve({ ...SEAL, unreadable: [] }))).toBe(false);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await anyRunnerUnder(() => Promise.reject(new Error("no seal")))).toBe(false);
      expect(logged).toHaveBeenCalledWith("[probe]", new Error("no seal"));
    } finally {
      logged.mockRestore();
    }
  });

  it("signs a CLI in under its runner's seal, free to open the browser, and not at all while the seal is refused", async () => {
    const sealed = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      () => Promise.resolve(sealing()),
    );
    sealed.init();
    expect(await sealed.sealedSignIn("codex", ["codex", "login"])).toEqual(
      signInCommand(sealing(), "codex", ["codex", "login"]),
    );
    const refused = createAgentDriver(
      () => Promise.resolve({ kind: "refused", reason: "no sandbox-exec here." }),
      () => Promise.resolve(sealing()),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      refused.init();
      await expect(refused.sealedSignIn("claude", ["claude", "auth", "login"])).rejects.toThrow(
        "no sandbox-exec here.",
      );
      expect(await refused.hasAnyRunner()).toBe(false);
    } finally {
      logged.mockRestore();
    }
  });

  it("is resolved again for every run, and none starts without one", async () => {
    let resolved = 0;
    const driver = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      () => {
        resolved += 1;
        return resolved === 1
          ? Promise.resolve(sealing())
          : Promise.reject(new Error(`no seal ${resolved}`));
      },
    );
    driver.init();
    expect(await driver.hasAnyRunner()).toBe(true);
    await expect(driver.completeOneShot("hire")).rejects.toThrow("no seal 2");
    await expect(driver.completeOneShot("hire")).rejects.toThrow("no seal 3");
  });

  it("reads a runner whose login a turn found refused as signed out, however often its stored login is read again", async () => {
    storedLoginClaude(0);
    const driver = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      () => Promise.resolve(SEAL),
    );
    driver.init();
    expect(await driver.hasAnyRunner()).toBe(true);
    expect(await driver.signedOut()).toEqual(["codex"]);

    driver.heed("claude", { error: "Failed to authenticate", kind: "signedOut" });

    expect(driver.signedIn("claude")).toBe(false);
    expect(await driver.hasAnyRunner()).toBe(false);
    await driver.refresh();
    expect(await driver.signedOut()).toEqual(["claude", "codex"]);
  });

  it("signs a refused login in again, though its stored login reads as signed in, and counts it only once that sign-in succeeds", async () => {
    const driver = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      () => Promise.resolve(SEAL),
    );
    storedLoginClaude(1);
    driver.init();
    driver.heed("claude", { error: "Failed to authenticate", kind: "signedOut" });
    const heard: AuthFlowEvent[] = [];
    await startLogin(driver, (e) => heard.push(e));
    expect(heard).toContainEqual(signingIn);
    expect(heard).not.toContainEqual({ type: "done" });
    expect(driver.signedIn("claude")).toBe(false);

    storedLoginClaude(0);
    heard.length = 0;
    await startLogin(driver, (e) => heard.push(e));
    expect(heard).toContainEqual(signingIn);
    expect(heard).toContainEqual({ type: "done" });
    expect(await driver.signedOut()).toEqual(["codex"]);
  });

  it("lets a task's run write only its own folders in the save, and the hiring one-shot none", async () => {
    const asked: (readonly string[])[] = [];
    const driver = createAgentDriver(
      () => Promise.resolve({ kind: "sealed" }),
      (writable) => {
        asked.push(writable);
        return asked.length === 1
          ? Promise.resolve(sealing())
          : Promise.reject(new Error("no seal"));
      },
    );
    driver.init();
    await driver.hasAnyRunner();
    const company = found();
    const [emp] = store.listEmployees();
    const [product] = store.listProducts();
    if (emp === undefined || product === undefined) {
      throw new Error("founded without a hire or a product");
    }
    const task = { description: "", id: "t", title: "work", workspace: product.workspaceDir };
    const tools = { asks: askBox(() => {}), call: () => Promise.resolve(null) };
    await expect(driver.completeOneShot("hire")).rejects.toThrow("no seal");
    await expect(
      driver.runTask(emp, company, task, () => {}, tools, new AbortController().signal),
    ).rejects.toThrow("no seal");
    expect(asked).toEqual([
      [],
      [],
      [
        product.workspaceDir,
        company.workspaceDir,
        path.join(root, company.id, "agents", emp.id, "memory"),
        path.join(root, "cache"),
      ],
    ]);
  });
});

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
    const agent = acpAgentFor("claude", SEAL);
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
