import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { runAcpTurn } from "@repo/agent-driver/acp-session";
import { addUsage, zeroUsage } from "@repo/agent-driver/events";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LivePage } from "@/shared/command-policy";
import type { BlockedAsk } from "@/shared/domain";
import { parseJson } from "@/shared/json";
import type { BrowserCli } from "./agent-driver";
import type { Seal, SealState } from "./seal";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-driver-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const store = await import("@/main/store/store");
const {
  BROWSER_NAMESPACE,
  PAGE_URLS,
  acpAgentFor,
  agentDriver,
  createAgentDriver,
  decidePermission,
  livePageOf,
  memoryAfter,
  outcomeOf,
} = await import("./agent-driver");
const { sealedCommand } = await import("./seal");

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
  otherLogin: {
    claude: [{ match: "prefix", path: "/Users/me/.codex" }],
    codex: [{ match: "prefix", path: "/Users/me/.claude" }],
  },
  sshAgent: "/private/var/run/com.apple.launchd.x/Listeners",
  unreadable: [{ match: "subpath", path: "/Users/me/.idlebiz/secrets.json" }],
  unwritable: [{ match: "subpath", path: "/Users/me/.zshrc" }],
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

describe("rest", () => {
  it("parks a runner until its limit lifts, and only that runner", () => {
    const until = Date.now() + 60_000;
    agentDriver.rest("claude", until);
    expect(agentDriver.restingRunner("claude")).toBe(until);
    expect(agentDriver.restingRunner("codex")).toBeNull();
    expect(agentDriver.restingRunners()).toEqual({ claude: until });
  });

  it("wakes a runner once its limit has lifted", () => {
    agentDriver.rest("codex", Date.now() - 1);
    expect(agentDriver.restingRunner("codex")).toBeNull();
    expect(agentDriver.restingRunners()).not.toHaveProperty("codex");
  });
});

describe("memoryAfter", () => {
  const stored = { instructionsDigest: "old", session: "kept" };

  it("remembers the session the turn ran, holding the instructions it was given", () => {
    expect(memoryAfter({ end: { kind: "completed" }, sessionId: "ran" }, stored, "new")).toEqual({
      instructionsDigest: "new",
      session: "ran",
    });
    expect(memoryAfter({ end: failed, sessionId: "ran" }, stored, "new")).toEqual({
      instructionsDigest: "new",
      session: "ran",
    });
  });

  it("leaves what was stored when the turn opened no session", () => {
    expect(memoryAfter({ end: failed }, stored, "new")).toEqual(stored);
  });

  it("forgets a session only a new one can follow", () => {
    const spent = { error: "context window exceeded", kind: "failed", sessionSpent: true } as const;
    expect(memoryAfter({ end: spent, sessionId: "kept" }, stored, "new")).toEqual({
      instructionsDigest: null,
      session: null,
    });
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
  const room = { cwd: workspace, save: root, writable: [workspace] };

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

  it("asks the founder before a run edits the save behind the store", async () => {
    const company = found();
    const asked: BlockedAsk[] = [];
    const request = { tool: { kind: "edit", paths: ["../approvals.json"] } } as const;
    const decision = await decidePermission(
      { companyId: company.id, id: "deploy" },
      request,
      new Set(),
      noPage,
      room,
      (ask) => asked.push(ask),
      new AbortController().signal,
    );
    expect(decision).toEqual({ allow: false });
    expect(asked).toEqual([
      {
        command: `edit: ${path.join(root, "acme", "approvals.json")}`,
        rule: "save-edit",
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

  it("starts agent-browser's Chrome without a sandbox of its own, in the runs' own daemon", () => {
    const { env } = acpAgentFor("codex", SEAL);
    expect(env.AGENT_BROWSER_ARGS).toBe("--no-sandbox");
    expect(env.AGENT_BROWSER_NAMESPACE).toBe(BROWSER_NAMESPACE);
  });

  it("runs codex in the mode that asks for everything and sandboxes nothing itself", () => {
    expect(acpAgentFor("codex", SEAL).sessionModeId).toBe("external-sandbox");
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
    expect(await livePageOf(browser)("mae")).toEqual({
      frames: [null],
      url: "http://localhost:3000/",
    });
    const scope = ["--namespace", BROWSER_NAMESPACE, "--session", "mae"];
    expect(asked).toEqual([
      [...scope, "session", "info", "--json"],
      [...scope, "eval", PAGE_URLS, "--json"],
    ]);
  });

  it("starts no daemon: a session with none shows no page", async () => {
    const { asked, browser } = browserAt(false, ["about:blank"]);
    expect(await livePageOf(browser)("")).toBeNull();
    expect(asked).toEqual([["--namespace", BROWSER_NAMESPACE, "session", "info", "--json"]]);
  });

  it("shows no page when agent-browser cannot answer", async () => {
    expect(await livePageOf(() => Promise.reject(new Error("ENOENT")))("")).toBeNull();
  });
});

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
  const holding: SealState = { kind: "sealed", seal: SEAL };

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

  it("probes a CLI's login in the env its runs get", async () => {
    const seen = path.join(cwd, "seen.json");
    const cli = path.join(cwd, "claude");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env)));`;
    writeFileSync(cli, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
    process.env.CLAUDE_BIN = cli;
    process.env.CODEX_BIN = path.join(cwd, "no-codex");

    await agentDriver.refresh();
    const probedWith = names.parse(parseJson(readFileSync(seen, "utf-8")));
    expect(probedWith).not.toContain("VERCEL_TOKEN");
    expect(probedWith).toContain("ANTHROPIC_API_KEY");
  });
});
