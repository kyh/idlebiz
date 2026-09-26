import { spawnSync } from "node:child_process";
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
import { once } from "node:events";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { LoadReport } from "@/shared/domain";
import { parseJson } from "@/shared/json";
import type { Seal, SealProbe } from "./seal";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-seal-root-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const {
  browserNamespace,
  checkSeal,
  machineSeal,
  notingSeal,
  realPathOf,
  sealFor,
  sealRuns,
  sealedCommand,
  signInCommand,
} = await import("./seal");

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

const SEAL: Seal = {
  browser: {
    namespaces: {
      claude: { match: "subpath", path: "/Users/me/.agent-browser/namespaces/idlebiz-c" },
      codex: { match: "subpath", path: "/Users/me/.agent-browser/namespaces/idlebiz-x" },
    },
    root: { match: "subpath", path: "/Users/me/.agent-browser" },
  },
  claudeMemory: { own: null, projects: "/Users/me/.claude/projects" },
  debugPorts: [9222],
  onPath: [],
  preferences: "/Users/me/Library/Preferences",
  runners: {
    claude: {
      config: [{ match: "prefix", path: "/Users/me/.claude/settings" }],
      folder: "/Users/me/.claude",
      state: [{ match: "prefix", path: "/Users/me/.claude" }],
    },
    codex: {
      config: [{ match: "prefix", path: "/Users/me/.codex/config.toml" }],
      folder: "/Users/me/.codex",
      state: [{ match: "prefix", path: "/Users/me/.codex" }],
    },
  },
  save: [{ match: "subpath", path: "/Users/me/.idlebiz" }],
  scratch: [{ match: "subpath", path: "/private/tmp" }],
  sockets: [],
  unreadable: [{ match: "subpath", path: "/Users/me/.idlebiz/secrets.json" }],
  writable: [],
};

const WORKSPACE = "/Users/me/.idlebiz/acme/workspace";

/** A sealed command read back: its profile, the paths it hands over, and what it runs. */
const readBack = (argv: readonly string[]) => {
  const [bin, flag, profile = "", ...rest] = argv;
  const params = new Map<string, string>();
  let at = 0;
  for (; rest[at] === "-D"; at += 2) {
    const define = rest[at + 1] ?? "";
    params.set(define.slice(0, define.indexOf("=")), define.slice(define.indexOf("=") + 1));
  }
  const lines = profile.split("\n");
  /** The paths the profile's `(<action> <operations> …)` rules name, in order. */
  const named = (action: "allow" | "deny", operations: string): string[] =>
    lines
      .filter((line) => line.startsWith(`(${action} ${operations} (`))
      .flatMap((rule) => [...rule.matchAll(/\(param "(?<name>P\d+)"\)/gu)])
      .map(({ groups }) => params.get(groups?.name ?? "") ?? "");
  /** The first line that is an `action` rule on `operations` naming `target`. */
  const lineOf = (action: "allow" | "deny", operations: string, target: string): number =>
    lines.findIndex(
      (line) =>
        line.startsWith(`(${action} ${operations} (`) &&
        [...line.matchAll(/\(param "(?<name>P\d+)"\)/gu)].some(
          ({ groups }) => params.get(groups?.name ?? "") === target,
        ),
    );
  return {
    allowed: (operations: string): string[] => named("allow", operations),
    bin,
    denied: (operations: string): string[] => named("deny", operations),
    flag,
    lineOf,
    lines,
    params: [...params.values()],
    profile,
    runs: rest.slice(at),
  };
};

describe("sealedCommand", () => {
  it("runs argv under sandbox-exec with the profile inline", () => {
    const { bin, flag, profile, runs } = readBack(sealedCommand(SEAL, "claude", ["node", "a.js"]));
    expect([bin, flag]).toEqual(["/usr/bin/sandbox-exec", "-p"]);
    expect(profile).toMatch(/^\(version 1\)\n\(allow default\)/u);
    expect(runs).toEqual(["node", "a.js"]);
  });

  it("hands every path over as a parameter, never quoted into the profile", () => {
    const odd = '/Users/me/we"ird) (allow file-read*';
    const { denied, profile } = readBack(
      sealedCommand({ ...SEAL, unreadable: [{ match: "subpath", path: odd }] }, "claude", []),
    );
    expect(profile).not.toContain('we"ird');
    expect(denied("file-read* file-write*")).toEqual([odd, "/Users/me/.codex"]);
  });

  it("denies every write, then allows each runner the scratch folders and its own home, never the other's", () => {
    const claude = readBack(sealedCommand(SEAL, "claude", []));
    const codex = readBack(sealedCommand(SEAL, "codex", []));
    for (const { lines } of [claude, codex]) {
      expect(lines.indexOf("(deny file-write*)")).toBeGreaterThan(-1);
      expect(lines.indexOf("(deny file-write*)")).toBeLessThan(
        lines.findIndex((line) => line.startsWith("(allow file-write* (subpath (param")),
      );
    }
    expect(claude.allowed("file-write*")).toEqual(
      expect.arrayContaining([
        "/private/tmp",
        "/Users/me/.claude",
        "/Users/me/.agent-browser/namespaces/idlebiz-c",
      ]),
    );
    expect(claude.allowed("file-write*")).not.toContain("/Users/me/.codex");
    expect(claude.denied("file-read* file-write*")).toContain("/Users/me/.codex");
    expect(codex.allowed("file-write*")).toContain("/Users/me/.codex");
    expect(codex.denied("file-read* file-write*")).toContain("/Users/me/.claude");
    expect(claude.denied("file-write*")).toContain("/Users/me/.claude/settings");
    expect(codex.denied("file-write*")).toContain("/Users/me/.codex/config.toml");
  });

  it("closes the Keychain to codex runs whichever program asks, and leaves it to claude's", () => {
    const keychain = /\(deny mach-lookup \(global-name "com\.apple\.SecurityServer"\)/u;
    const claude = readBack(sealedCommand(SEAL, "claude", [])).profile;
    const codex = readBack(sealedCommand(SEAL, "codex", [])).profile;
    expect(codex).toMatch(keychain);
    expect(claude).not.toMatch(keychain);
    expect(`${claude}${codex}`).not.toContain("/usr/bin/security");
  });

  it("closes the save, reopens the run's own folders, then holds every later rule inside them", () => {
    const seal: Seal = {
      ...SEAL,
      claudeMemory: {
        own: "/Users/me/.claude/projects/-w/memory",
        projects: "/Users/me/.claude/projects",
      },
      writable: [{ match: "subpath", path: WORKSPACE }],
    };
    const { lineOf, lines, denied } = readBack(sealedCommand(seal, "claude", []));
    const scratch = lineOf("allow", "file-write*", "/private/tmp");
    const save = lineOf("deny", "file-write*", "/Users/me/.idlebiz");
    const reopened = lineOf("allow", "file-write*", WORKSPACE);
    const config = lineOf("deny", "file-write*", "/Users/me/.claude/settings");
    const opened = lines.findIndex((line) => line.includes('(require-not (regex #"/\\.git/'));
    const kept = lineOf("deny", "file-write-create file-write-unlink", WORKSPACE);
    expect([scratch, save, reopened, config, opened, kept].every((at) => at > -1)).toBe(true);
    expect(scratch).toBeLessThan(save);
    expect(save).toBeLessThan(reopened);
    expect(reopened).toBeLessThan(config);
    expect(reopened).toBeLessThan(opened);
    expect(reopened).toBeLessThan(kept);
    expect(denied("file-write-create file-write-unlink")).toContain(WORKSPACE);
    const others = lines.findIndex((line) => line.includes("/memory(/|$)"));
    expect(others).toBeGreaterThan(-1);
    expect(lineOf("allow", "file-write*", "/Users/me/.claude/projects/-w/memory")).toBeGreaterThan(
      others,
    );
    expect(readBack(sealedCommand(seal, "codex", [])).profile).not.toContain("/memory(/|$)");
  });

  it("lets no run open anything through LaunchServices, and only a sign-in open the browser", () => {
    const opensNothing = "(deny lsopen)";
    for (const runner of ["claude", "codex"] as const) {
      expect(readBack(sealedCommand(SEAL, runner, [])).lines).toContain(opensNothing);
      expect(readBack(signInCommand(SEAL, runner, [])).lines).not.toContain(opensNothing);
    }
  });

  it("keeps the founder's sockets, other agent-browser daemons and the debug ports out of reach", () => {
    const agent = "/Users/me/.orbstack/run";
    const { allowed, denied, lineOf, profile } = readBack(
      sealedCommand({ ...SEAL, sockets: [{ match: "subpath", path: agent }] }, "claude", []),
    );
    expect(denied("network-outbound")).toEqual([
      "/Users/me/.idlebiz/secrets.json",
      "/Users/me/.codex",
      agent,
      "/Users/me/.agent-browser",
    ]);
    expect(allowed("network-outbound")).toEqual(["/Users/me/.agent-browser/namespaces/idlebiz-c"]);
    expect(
      lineOf("allow", "network-outbound", "/Users/me/.agent-browser/namespaces/idlebiz-c"),
    ).toBeGreaterThan(lineOf("deny", "network-outbound", "/Users/me/.agent-browser"));
    expect(denied("file-write*")).toContain(agent);
    expect(profile).toContain('(deny network-outbound (remote tcp "localhost:9222"))');
  });

  it("leaves out a rule with nothing to reach, which would reach everything", () => {
    const bare: Seal = {
      ...SEAL,
      debugPorts: [],
      runners: {
        claude: { config: [], folder: "/Users/me/.claude", state: [] },
        codex: { config: [], folder: "/Users/me/.codex", state: [] },
      },
      save: [],
      scratch: [],
      unreadable: [],
    };
    const { lines } = readBack(sealedCommand(bare, "claude", []));
    // each on purpose: lsopen whole, since an app LaunchServices starts runs unsealed; writes
    // whole, since a run writes only where a later rule allows it
    expect(lines.filter((line) => /^\((?:allow|deny) [\w* -]+\)$/u.test(line))).toEqual([
      "(allow default)",
      "(deny lsopen)",
      "(deny file-write*)",
    ]);
  });
});

describe("notingSeal", () => {
  const report: LoadReport = {
    companies: 1,
    skipped: [{ error: "bad yaml", kind: "task", path: "/save/tasks/x/TASK.md" }],
  };

  it("tells the founder beside the save's notes why no run starts", () => {
    expect(notingSeal(report, "sandbox-exec timed out, so none will start.")).toEqual({
      companies: 1,
      skipped: [
        ...report.skipped,
        {
          error: "sandbox-exec timed out, so none will start.",
          kind: "seal",
          path: "/usr/bin/sandbox-exec",
        },
      ],
    });
  });

  it("adds nothing while runs start sealed", () => {
    expect(notingSeal(report, null)).toBe(report);
  });
});

describe("checkSeal", () => {
  it("runs each runner's runtime under the profile against canaries where no rule lets it write, never the real keys", async () => {
    const seen: { argv: readonly string[]; env: Record<string, string> }[] = [];
    const refusal = await checkSeal(SEAL, (argv, env) => {
      seen.push({ argv, env });
      return Promise.resolve(0);
    });
    expect(refusal).toBeNull();
    expect(seen).toHaveLength(2);
    for (const { argv, env } of seen) {
      const { allowed, denied, runs } = readBack(argv);
      const [canary = "", written = ""] = runs.slice(-2);
      expect(canary).not.toBe("/Users/me/.idlebiz/secrets.json");
      expect(denied("file-read* file-write*")).toContain(canary);
      expect(denied("file-read* file-write*")).toContain("/Users/me/.idlebiz/secrets.json");
      expect(path.dirname(written)).toBe(path.dirname(canary));
      expect(allowed("file-write*")).not.toContain("/private/tmp");
      expect(runs[0]).toBe(process.execPath);
      expect(env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
      expect(existsSync(canary)).toBe(false);
    }
  });

  it.each([
    [null, "could not run macOS's sandbox-exec"],
    [3, "let a run read a file it seals"],
    [5, "let a run write outside its own folders"],
    [71, "(exit 71)"],
  ])("refuses every run when a probe ends %s", async (code, sentence) => {
    const refusal = await checkSeal(SEAL, (argv) =>
      Promise.resolve(argv.some((word) => word.endsWith("written-by-codex")) ? code : 0),
    );
    expect(refusal).toContain(sentence);
  });
});

const onMac = process.platform === "darwin";

/** How `argv` exited, run as it stands. */
const exitOf = (argv: readonly string[]): number | null => {
  const [bin = "", ...args] = argv;
  return spawnSync(bin, args, { encoding: "utf-8" }).status;
};

/** A real probe of the checked command, its profile swapped for `profile`. */
const under =
  (profile: string): SealProbe =>
  (argv, env) =>
    Promise.resolve(
      spawnSync(argv[0] ?? "", [argv[1] ?? "", profile, ...argv.slice(3)], { env }).status,
    );

/**
 * What each file came to under the profile: "removed", "moved", "made", "linked", "read",
 * "written" or "ran", or the error that stopped it.
 */
const Outcomes = z.record(z.string(), z.string());

const TRY_FILES = `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { removes = [], moves = [], dirs = [], symlinks = [], links = [], reads = [], writes = [], runs = [] } = JSON.parse(process.argv[1]);
const out = {};
const attempt = (key, done, act) => { try { act(); out[key] = done; } catch (e) { out[key] = e.code; } };
for (const dir of removes) attempt(dir, "removed", () => fs.rmSync(dir, { recursive: true }));
for (const [from, to] of moves) attempt(from, "moved", () => fs.renameSync(from, to));
for (const dir of dirs) attempt(dir, "made", () => fs.mkdirSync(dir, { recursive: true }));
for (const [target, to] of symlinks) attempt(to, "linked", () => fs.symlinkSync(target, to));
for (const [from, to] of links) attempt(to, "linked", () => fs.linkSync(from, to));
for (const file of reads) attempt(file, "read", () => fs.readFileSync(file));
for (const file of writes) attempt(file, "written", () => fs.appendFileSync(file, "x"));
for (const bin of runs) { const r = spawnSync(bin, ["help"]); out[bin] = r.error ? r.error.code : "ran"; }
console.log(JSON.stringify(out));
`;

/** What a run tries, each kind in this order: a key names each `[from, to]` by `to`, but a move by `from`. */
interface Attempts {
  removes?: string[];
  moves?: [string, string][];
  dirs?: string[];
  symlinks?: [string, string][];
  links?: [string, string][];
  reads?: string[];
  writes?: string[];
  runs?: string[];
}

/** Every one of `files` came to `outcome`. */
const all = (files: readonly string[], outcome: string): Record<string, string> =>
  Object.fromEntries(files.map((file) => [file, outcome]));

describe.skipIf(!onMac)("the profile, on canaries under a stand-in home", () => {
  // home sits in a box of its own, so a rename the seal failed to stop is still cleaned up
  let box = "";
  let home = "";
  const at = (file: string): string => path.join(home, file);
  const plant = (file: string): string => {
    mkdirSync(path.dirname(at(file)), { recursive: true });
    writeFileSync(at(file), "canary");
    return at(file);
  };
  /** `name` in home as a symlink to `target`, a folder when `target` ends in a slash. */
  const link = (name: string, target: string): string => {
    if (target.endsWith("/")) {
      mkdirSync(at(target), { recursive: true });
    } else {
      plant(target);
    }
    mkdirSync(path.dirname(at(name)), { recursive: true });
    symlinkSync(at(target), at(name));
    return at(target);
  };
  /** The folders a run on acme's workspace writes, as the driver hands them over. */
  const own = () => [
    at(".idlebiz/acme/workspace"),
    at(".idlebiz/acme/agents/ann/memory"),
    at(".idlebiz/cache"),
  ];
  const seal = (more: Partial<Parameters<typeof sealFor>[0]> = {}): Promise<Seal> =>
    sealFor({
      clis: [],
      debugPorts: [],
      env: {},
      home,
      mainOnly: [at(".idlebiz/secrets.json")],
      pathDirs: [],
      save: at(".idlebiz"),
      scratch: [at("tmp")],
      sshAgent: null,
      writable: own(),
      ...more,
    });
  const tryAs = async (
    runner: "claude" | "codex",
    files: Attempts,
    sealed: Promise<Seal> = seal(),
  ) => {
    const argv = sealedCommand(await sealed, runner, [
      process.execPath,
      "-e",
      TRY_FILES,
      JSON.stringify(files),
    ]);
    const [bin = "", ...args] = argv;
    const { stdout } = spawnSync(bin, args, { encoding: "utf-8", env: { HOME: home } });
    return Outcomes.parse(parseJson(stdout));
  };

  beforeEach(() => {
    box = realpathSync(mkdtempSync(path.join(tmpdir(), "idlebiz-home-")));
    home = path.join(box, "home");
    mkdirSync(home);
    for (const folder of [...own(), at("tmp")]) {
      mkdirSync(folder, { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(box, { force: true, recursive: true });
  });

  const LOGINS = [
    ".ssh/id_ed25519",
    ".config/gh/hosts.yml",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".config/git/credentials",
    ".aws/credentials",
    ".azure/msal_token_cache.json",
    ".kube/config",
    ".docker/config.json",
    ".gnupg/private-keys-v1.d/key",
    ".config/gcloud/credentials.db",
    ".config/stripe/config.toml",
    ".wrangler/config/default.toml",
    ".config/.wrangler/config/default.toml",
    "Library/Preferences/.wrangler/config/default.toml",
    ".config/netlify/config.json",
    "Library/Preferences/netlify/config.json",
    "Library/Application Support/com.vercel.cli/auth.json",
    ".local/share/com.vercel.cli/auth.json",
    ".fly/config.yml",
    ".railway/config.json",
    ".supabase/access-token",
    ".terraform.d/credentials.tfrc.json",
    ".pypirc",
    ".cargo/credentials.toml",
    ".config/configstore/firebase-tools.json",
    ".config/op/config",
    ".config/github-copilot/apps.json",
    ".agent-browser/auth/site.json",
    ".agent-browser/.encryption-key",
    "Library/Application Support/Google/Chrome/Default/Cookies",
    "Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies",
    "Library/Application Support/Arc/User Data/Default/Cookies",
    "Library/Application Support/Firefox/Profiles/a/cookies.sqlite",
    "Library/Application Support/Microsoft Edge/Default/Cookies",
    "Library/Application Support/Slack/Cookies",
    "Library/Application Support/discord/Local Storage/leveldb/x.ldb",
    "Library/Cookies/Cookies.binarycookies",
    ".idlebiz/secrets.json",
  ];

  it.each(["claude", "codex"] as const)(
    "keeps the founder's logins and IdleBiz's keys from a %s run, reads and writes alike",
    async (runner) => {
      const files = LOGINS.map(plant);
      expect(await tryAs(runner, { reads: files })).toEqual(all(files, "EPERM"));
      expect(await tryAs(runner, { writes: files })).toEqual(all(files, "EPERM"));
    },
  );

  it("reads the rest of home but writes none of it", async () => {
    const files = [
      ".zshrc",
      ".zshenv",
      ".config/git/config",
      ".gitconfig",
      "Library/LaunchAgents/com.example.agent.plist",
      "Documents/notes.md",
      "projects/app/.env",
      "projects/app/package.json",
      ".local/bin/tool",
      ".cache/node/corepack/pnpm/9.0.0/bin/pnpm.cjs",
      "Library/Caches/ms-playwright/chromium/chrome",
      ".agent-browser/config.json",
    ].map(plant);
    const fresh = [at("Documents/new.md"), at(".zlogin"), at("Library/LaunchAgents/new.plist")];
    expect(await tryAs("codex", { reads: files })).toEqual(all(files, "read"));
    expect(await tryAs("claude", { writes: [...files, ...fresh] })).toEqual(
      all([...files, ...fresh], "EPERM"),
    );
    expect(
      await tryAs("codex", {
        dirs: [at(".bun/bin")],
        moves: [[at("projects/app"), at("projects/app-old")]],
        removes: [at("Documents")],
      }),
    ).toEqual({
      [at(".bun/bin")]: "EPERM",
      [at("projects/app")]: "EPERM",
      [at("Documents")]: "EPERM",
    });
    expect(existsSync(at("Documents/notes.md"))).toBe(true);
  });

  it("writes the scratch folders, and node CLIs' preferences but no other", async () => {
    const writes = [
      at("tmp/build.log"),
      at("Library/Preferences/create-next-app-nodejs/config.json"),
    ];
    mkdirSync(at("Library/Preferences/create-next-app-nodejs"), { recursive: true });
    const plist = plant("Library/Preferences/com.example.app.plist");
    expect(await tryAs("codex", { writes: [...writes, plist] })).toEqual({
      ...all(writes, "written"),
      [plist]: "EPERM",
    });
  });

  it("keeps each runner's own login and seals the other's, where a symlink leads too", async () => {
    const codexLogin = plant(".codex/auth.json");
    const claudeDir = plant(".claude/settings.json");
    const claudeState = at(".claude.json");
    const claudeStateTarget = link(".claude.json", "dotfiles/claude.json");
    const reads = [codexLogin, claudeState, claudeStateTarget, claudeDir];
    expect(await tryAs("claude", { reads })).toEqual({
      ...all([claudeDir, claudeState, claudeStateTarget], "read"),
      [codexLogin]: "EPERM",
    });
    expect(await tryAs("codex", { reads })).toEqual({
      ...all([claudeDir, claudeState, claudeStateTarget], "EPERM"),
      [codexLogin]: "read",
    });
  });

  it.each(["claude", "codex"] as const)(
    "lets a %s run write its runner's state but not what its CLI runs in the founder's own sessions",
    async (runner) => {
      const config =
        runner === "claude"
          ? [
              ".claude/settings.json",
              ".claude/settings.local.json",
              ".claude/settings.json.tmp.1",
              ".claude/CLAUDE.md",
              ".claude/rules/a.md",
              ".claude/hooks/pre.sh",
              ".claude/skills/a/SKILL.md",
              ".claude/agents/a.md",
              ".claude/commands/a.md",
              ".claude/workflows/a.md",
              ".claude/plugins/installed_plugins.json",
              ".claude/output-styles/a.md",
              ".claude/scheduled-tasks/a.json",
              ".claude/local/claude",
              ".claude/shell-snapshots/snapshot-zsh-1.sh",
              ".claude/session-env/a/hook-0.sh",
              ".claude/chrome/chrome-native-host",
              ".claude/ide/41234.lock",
            ]
          : [
              ".codex/config.toml",
              ".codex/hooks.json",
              ".codex/AGENTS.md",
              ".codex/AGENTS.override.md",
              ".codex/rules/default.rules",
              ".codex/prompts/a.md",
              ".codex/skills/a/SKILL.md",
              ".codex/plugins/a.json",
              ".codex/packages/standalone/bin/codex",
              ".codex/.env",
              ".codex/.env.local",
              ".codex/shell_snapshots/a.sh",
              ".codex/memories/memory_summary.md",
              ".codex/computer-use/Codex Computer Use.app/Contents/MacOS/run",
              ".codex/worktrees/a/app/package.json",
            ];
      const kept = config.map(plant);
      const state = (
        runner === "claude"
          ? [".claude/projects/a/session.jsonl", ".claude.json", ".claude.json.backup"]
          : [".codex/sessions/a.jsonl", ".codex/history.jsonl", ".codex/memories_1.sqlite"]
      ).map(plant);
      expect(await tryAs(runner, { reads: kept })).toEqual(all(kept, "read"));
      expect(await tryAs(runner, { writes: kept })).toEqual(all(kept, "EPERM"));
      expect(await tryAs(runner, { writes: state })).toEqual(all(state, "written"));
    },
  );

  it("keeps a runner's instructions where a symlink leads, as a dotfile manager sets them up", async () => {
    const target = link(".claude/CLAUDE.md", "tmp/dots/CLAUDE.md");
    const scratch = plant("tmp/dots/notes.md");
    expect(await tryAs("claude", { writes: [target, scratch] })).toEqual({
      [scratch]: "written",
      [target]: "EPERM",
    });
  });

  it("lets a claude run keep what it learns about its own folder, and no other's", async () => {
    const workspace = realpathSync(at(".idlebiz/acme/workspace"));
    const mine = at(
      `.claude/projects/${workspace.replaceAll(/[^a-zA-Z0-9]/gu, "-")}/memory/MEMORY.md`,
    );
    mkdirSync(path.dirname(mine), { recursive: true });
    const theirs = plant(".claude/projects/-Users-me-app/memory/MEMORY.md");
    const transcript = plant(".claude/projects/-Users-me-app/session.jsonl");
    expect(await tryAs("claude", { writes: [mine, theirs, transcript] })).toEqual({
      [mine]: "written",
      [theirs]: "EPERM",
      [transcript]: "written",
    });
  });

  it("keeps the rest of the save from a run, so it forges no approval, verdict or teammate", async () => {
    const workspace = plant(".idlebiz/acme/workspace/index.html");
    const memory = plant(".idlebiz/acme/agents/ann/memory/notes.md");
    const cache = plant(".idlebiz/cache/npm/_cacache/x");
    const forged = [
      plant(".idlebiz/acme/approvals.json"),
      plant(".idlebiz/acme/bets/more-users/BET.md"),
      plant(".idlebiz/acme/agents/ann/AGENTS.md"),
      plant(".idlebiz/acme/agents/bob/AGENTS.md"),
      plant(".idlebiz/acme/agents/bob/memory/notes.md"),
      plant(".idlebiz/acme/tasks/landing/TASK.md"),
      plant(".idlebiz/acme/shared/brief.md"),
      at(".idlebiz/acme/tasks/landing/PLAN.md"),
      at(".idlebiz/office-design.json"),
    ];
    const linked = at(".idlebiz/acme/workspace/approvals.json");
    expect(
      await tryAs("claude", {
        links: [[at(".idlebiz/acme/approvals.json"), linked]],
        writes: [workspace, memory, cache, ...forged],
      }),
    ).toEqual({
      ...all(forged, "EPERM"),
      ...all([workspace, memory, cache], "written"),
      [linked]: "EPERM",
    });
    expect(await tryAs("claude", { writes: [workspace, memory] }, seal({ writable: [] }))).toEqual(
      all([workspace, memory], "EPERM"),
    );
  });

  it("closes a save that sits in a scratch folder, as a test's does, but for the run's own folders", async () => {
    const save = at("tmp/save");
    const workspace = path.join(save, "acme/workspace");
    mkdirSync(workspace, { recursive: true });
    const sealed = seal({ save, writable: [workspace] });
    const approvals = path.join(save, "acme/approvals.json");
    const writes = [approvals, path.join(workspace, "index.html"), at("tmp/other.log")];
    expect(await tryAs("codex", { writes }, sealed)).toEqual({
      ...all(writes, "written"),
      [approvals]: "EPERM",
    });
  });

  it.each(["claude", "codex"] as const)(
    "keeps a %s run from writing what the founder's tools run on opening its folder",
    async (runner) => {
      const opened = [
        plant(".idlebiz/acme/workspace/.git/config"),
        plant(".idlebiz/acme/workspace/.git/hooks/pre-commit.sample"),
        at(".idlebiz/acme/workspace/.git/hooks/pre-commit"),
        at(".idlebiz/acme/workspace/.git/config.lock"),
        at(".idlebiz/acme/workspace/.git/commondir"),
        plant(".idlebiz/acme/workspace/.git/info/attributes"),
        plant(".idlebiz/acme/workspace/.git/worktrees/w/config.worktree"),
        at(".idlebiz/acme/workspace/.git/worktrees/w/commondir"),
        plant(".idlebiz/acme/workspace/.git/modules/m/config"),
        plant(".idlebiz/acme/workspace/.git/objects/info/alternates"),
        plant(".idlebiz/acme/workspace/web/.git/config"),
        at(".idlebiz/acme/workspace/.mcp.json"),
        plant(".idlebiz/acme/workspace/.claude/settings.json"),
        at(".idlebiz/acme/workspace/.claude/settings.local.json"),
        at(".idlebiz/acme/agents/ann/memory/.codex"),
      ];
      mkdirSync(at(".idlebiz/acme/workspace/.git/objects/ab"), { recursive: true });
      mkdirSync(at(".idlebiz/acme/workspace/.git/logs"), { recursive: true });
      const work = [
        plant(".idlebiz/acme/workspace/.git/index"),
        at(".idlebiz/acme/workspace/.git/index.lock"),
        at(".idlebiz/acme/workspace/.git/COMMIT_EDITMSG"),
        at(".idlebiz/acme/workspace/.git/objects/ab/cdef"),
        at(".idlebiz/acme/workspace/.git/logs/HEAD"),
        plant(".idlebiz/acme/workspace/.git/refs/heads/main"),
        plant(".idlebiz/acme/workspace/.claude/notes.md"),
        plant(".idlebiz/acme/workspace/src/config"),
        plant(".idlebiz/acme/workspace/hooks/use-x.ts"),
      ];
      const workspace = at(".idlebiz/acme/workspace");
      expect(
        await tryAs(runner, {
          dirs: [path.join(workspace, ".git/alt")],
          moves: [
            [path.join(workspace, ".git"), path.join(workspace, "git-old")],
            [path.join(workspace, ".claude"), path.join(workspace, "claude-old")],
          ],
          writes: [...opened, ...work],
        }),
      ).toEqual({
        ...all(opened, "EPERM"),
        ...all(work, "written"),
        [path.join(workspace, ".claude")]: "EPERM",
        [path.join(workspace, ".git")]: "EPERM",
        [path.join(workspace, ".git/alt")]: "EPERM",
      });
    },
  );

  it("lets a run commit, branch, merge, rebase, stash and gc in the repository main made, never changing its config", () => {
    const workspace = at(".idlebiz/acme/workspace");
    const env = {
      GIT_AUTHOR_EMAIL: "ann@idlebiz.local",
      GIT_AUTHOR_NAME: "Ann",
      GIT_COMMITTER_EMAIL: "ann@idlebiz.local",
      GIT_COMMITTER_NAME: "Ann",
      HOME: home,
      PATH: "/usr/bin:/bin",
    };
    spawnSync("/usr/bin/git", ["init", "-q", "-b", "main"], { cwd: workspace, env });
    const config = readFileSync(path.join(workspace, ".git/config"), "utf-8");
    const work = [
      "echo a > a && git add a && git commit -qm a",
      "git checkout -qb feature && echo b > b && git add b && git commit -qm b",
      "git checkout -q main && echo c > c && git add c && git commit -qm c",
      "git merge -q --no-edit feature",
      "git checkout -qb topic feature && echo d > d && git add d && git commit -qm d",
      "git rebase -q main",
      "echo e >> a && git stash -q && git stash pop -q",
      "git diff --stat && git log --oneline",
      "git gc -q",
    ].join(" && ");
    return seal().then((sealed) => {
      const run = (script: string) => {
        const [bin = "", ...args] = sealedCommand(sealed, "codex", ["/bin/sh", "-c", script]);
        return spawnSync(bin, args, { cwd: workspace, encoding: "utf-8", env });
      };
      const done = run(`set -e; ${work}`);
      expect(done.stderr).toBe("");
      expect(done.status).toBe(0);
      expect(run("git config user.name Mallory").status).not.toBe(0);
      expect(run("git worktree add -q ../w").status).not.toBe(0);
      expect(readFileSync(path.join(workspace, ".git/config"), "utf-8")).toBe(config);
      expect(run("git log --format=%an topic").stdout.trim().split("\n")).toEqual(
        Array.from({ length: 5 }, () => "Ann"),
      );
    });
  });

  it("keeps a run from reading a sibling of secrets.json, where the save is named and where it leads", async () => {
    link("linked-save", "elsewhere/idlebiz/");
    const stale = plant("elsewhere/idlebiz/secrets.json.tmp");
    const named = at("linked-save/secrets.json.tmp");
    const sealed = seal({
      mainOnly: [at("linked-save/secrets.json")],
      save: at("linked-save"),
      writable: [],
    });
    expect(await tryAs("codex", { reads: [named, stale] }, sealed)).toEqual(
      all([named, stale], "EPERM"),
    );
  });

  it("keeps a run from changing a folder on PATH that lies in a folder it writes, and where its links lead", async () => {
    const shims = at("tmp/shims/bin");
    const shim = plant("tmp/shims/bin/claude");
    const tool = link(".local/bin/tool", "tmp/tools/bin/tool");
    const later = at("tmp/later/bin");
    const sealed = seal({ pathDirs: [shims, at(".local/bin"), later, "node_modules/.bin"] });
    const writes = [shim, path.join(shims, "codex"), tool, at("tmp/tools/bin/other")];
    expect(
      await tryAs(
        "claude",
        {
          dirs: [later],
          moves: [[at("tmp/shims"), at("tmp/shims-old")]],
          writes: [...writes, at("tmp/free.log")],
        },
        sealed,
      ),
    ).toEqual({
      ...all(writes, "EPERM"),
      [at("tmp/free.log")]: "written",
      [at("tmp/shims")]: "EPERM",
      [later]: "EPERM",
    });
    const { onPath } = await sealed;
    expect(onPath.map(({ path: kept }) => kept)).toEqual(
      expect.arrayContaining([shims, at("tmp/tools/bin"), later]),
    );
    expect(onPath.map(({ path: kept }) => kept)).not.toContain(at(".local/bin"));
  });

  it("keeps a run from swapping a folder of its own for a link, so the next run's seal holds too", async () => {
    const approvals = plant(".idlebiz/acme/approvals.json");
    const memory = at(".idlebiz/acme/agents/ann/memory");
    const cache = at(".idlebiz/cache");
    plant(".idlebiz/cache/npm/x");
    const swap = at(".idlebiz/acme/workspace/swap");
    mkdirSync(swap);
    const first = seal();
    expect(await tryAs("codex", { removes: [memory, cache] }, first)).toEqual(
      all([memory, cache], "EPERM"),
    );
    expect(existsSync(at(".idlebiz/cache/npm"))).toBe(false);
    expect(
      await tryAs(
        "codex",
        {
          moves: [
            [memory, at(".idlebiz/acme/workspace/memory")],
            [swap, cache],
          ],
        },
        first,
      ),
    ).toEqual(all([memory, swap], "EPERM"));
    const inMemory = path.join(memory, "save");
    expect(await tryAs("codex", { symlinks: [[at(".idlebiz"), inMemory]] }, first)).toEqual({
      [inMemory]: "linked",
    });
    const through = path.join(inMemory, "acme/approvals.json");
    expect(await tryAs("codex", { writes: [approvals, through] }, seal())).toEqual(
      all([approvals, through], "EPERM"),
    );
  });

  it("starts no run whose folder is a link or lies outside the save", async () => {
    await expect(seal()).resolves.toBeDefined();
    const ann = at(".idlebiz/acme/agents/ann");
    const memory = path.join(ann, "memory");
    rmSync(memory, { recursive: true });
    symlinkSync(at(".idlebiz"), memory);
    await expect(seal()).rejects.toThrow(`while ${memory} is a symlink`);
    rmSync(ann, { recursive: true });
    mkdirSync(at("elsewhere/ann"), { recursive: true });
    symlinkSync(at("elsewhere/ann"), ann);
    await expect(seal()).rejects.toThrow(`while ${ann} is a symlink`);
    for (const folder of [at("projects/app"), at(".idlebiz")]) {
      await expect(seal({ writable: [folder] })).rejects.toThrow("no folder inside the save");
    }
  });

  it("keeps a run from starting an app through LaunchServices, which would run it unsealed", async () => {
    const app = at("tmp/Canary.app");
    const launched = at("tmp/launched");
    mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
    writeFileSync(
      path.join(app, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>canary</string>
<key>CFBundleIdentifier</key><string>io.idlebiz.seal-canary.${process.pid}.${Date.now()}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
    );
    writeFileSync(path.join(app, "Contents/MacOS/canary"), `#!/bin/sh\ntouch '${launched}'\n`, {
      mode: 0o755,
    });
    const sealed = await seal();
    const argv = ["/usr/bin/open", "-g", "-n", app];
    expect(exitOf(sealedCommand(sealed, "claude", argv))).not.toBe(0);
    await sleep(1500);
    expect(existsSync(launched)).toBe(false);
    // the control: the same open from a sign-in, which may open the browser, does start it
    expect(exitOf(signInCommand(sealed, "claude", argv))).toBe(0);
    for (let waited = 0; waited < 50 && !existsSync(launched); waited += 1) {
      await sleep(100);
    }
    expect(existsSync(launched)).toBe(true);
  });

  it("lets a run list processes, as version managers do to find their shell", async () => {
    const sealed = await seal();
    for (const runner of ["claude", "codex"] as const) {
      expect(exitOf(sealedCommand(sealed, runner, ["/bin/ps", "-p", "1", "-o", "pid="]))).toBe(0);
    }
  });

  it("keeps a run from the CLIs that drive other apps, which a sign-in may still run", async () => {
    const sealed = await seal();
    const script = ["/usr/bin/osascript", "-e", "return 1"];
    expect(exitOf(sealedCommand(sealed, "codex", script))).not.toBe(0);
    expect(exitOf(signInCommand(sealed, "codex", script))).toBe(0);
  });

  it("stops git's Keychain helper for every run", async () => {
    const helper = plant("bin/git-credential-osxkeychain");
    spawnSync("chmod", ["+x", helper]);
    for (const runner of ["claude", "codex"] as const) {
      expect(await tryAs(runner, { runs: [helper] })).toEqual({ [helper]: "EPERM" });
    }
  });

  describe("a socket", () => {
    // a socket's path must fit in 104 bytes: tmpdir() on macOS alone takes half of that
    let short = "";
    let launchd = "";
    const servers: Server[] = [];
    const listen = async (socket: string): Promise<string> => {
      mkdirSync(path.dirname(socket), { recursive: true });
      const server = createServer();
      servers.push(server);
      server.listen(socket);
      await once(server, "listening");
      return socket;
    };
    beforeEach(() => {
      short = realpathSync(mkdtempSync("/tmp/ib-"));
      launchd = realpathSync(mkdtempSync("/tmp/com.apple.launchd.ib-"));
    });
    afterEach(() => {
      for (const server of servers.splice(0)) {
        server.close();
      }
      rmSync(short, { force: true, recursive: true });
      rmSync(launchd, { force: true, recursive: true });
    });

    // "connect" fires once the kernel queues it: this process, blocked in spawnSync, never accepts
    const CONNECT = `
const net = require("node:net");
const fs = require("node:fs");
const [targets, moves] = JSON.parse(process.argv[1]);
const out = {};
for (const [from, to] of moves) { try { fs.renameSync(from, to); out[from] = "moved"; } catch (e) { out[from] = e.code; } }
let left = targets.length;
const done = (target, outcome) => { out[target] = outcome; if (--left === 0) { console.log(JSON.stringify(out)); process.exit(0); } };
for (const target of targets) {
  const [host, port] = target.split("#");
  const connection = port === undefined ? net.connect(target) : net.connect(Number(port), host);
  connection.on("connect", () => done(target, "reached"));
  connection.on("error", (error) => done(target, error.code));
}
`;
    const connect = async (
      runner: "claude" | "codex",
      targets: readonly string[],
      more: Partial<Parameters<typeof sealFor>[0]> = {},
      moves: readonly [string, string][] = [],
    ) => {
      const sealed = await sealFor({
        clis: [],
        debugPorts: [],
        env: {},
        home: short,
        mainOnly: [],
        pathDirs: [],
        save: path.join(short, ".idlebiz"),
        scratch: [short, launchd],
        sshAgent: null,
        writable: [],
        ...more,
      });
      const argv = sealedCommand(sealed, runner, [
        process.execPath,
        "-e",
        CONNECT,
        JSON.stringify([targets, moves]),
      ]);
      const [bin = "", ...args] = argv;
      return Outcomes.parse(parseJson(spawnSync(bin, args, { encoding: "utf-8" }).stdout));
    };

    it("is out of reach under a sealed folder or a container engine's, while one in a scratch folder answers", async () => {
      const sockets = await Promise.all(
        [
          ".ssh/agent.sock",
          ".gnupg/S.gpg-agent.ssh",
          "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
          ".orbstack/run/docker.sock",
          ".colima/default/docker.sock",
          "work/app.sock",
        ].map((name) => listen(path.join(short, name))),
      );
      const reached = sockets.at(-1) ?? "";
      expect(await connect("claude", sockets)).toEqual({
        ...all(sockets.slice(0, -1), "EPERM"),
        [reached]: "reached",
      });
    });

    it("is out of reach where the codex app listens in codex's home, though a codex run writes the rest of it", async () => {
      const app = await listen(path.join(short, ".codex/ipc/ipc.sock"));
      const other = await listen(path.join(short, ".codex/tmp/run.sock"));
      expect(await connect("codex", [app, other])).toEqual({
        [app]: "EPERM",
        [other]: "reached",
      });
    });

    it("reaches only the agent-browser daemons its own runner's runs start", async () => {
      const namespaces = path.join(short, ".agent-browser/namespaces");
      const [claude, codex, founder] = await Promise.all([
        listen(path.join(namespaces, browserNamespace("claude"), "run/d.sock")),
        listen(path.join(namespaces, browserNamespace("codex"), "run/d.sock")),
        listen(path.join(short, ".agent-browser/default.sock")),
      ]);
      expect(await connect("claude", [claude, codex, founder])).toEqual({
        ...all([codex, founder], "EPERM"),
        [claude]: "reached",
      });
      expect(await connect("codex", [claude, codex, founder])).toEqual({
        ...all([claude, founder], "EPERM"),
        [codex]: "reached",
      });
    });

    it("is out of reach where an ssh-agent started from a terminal names it, wherever its TMPDIR is, and stays put", async () => {
      const agent = await listen(path.join(short, "ssh-AbC123/agent.4242"));
      const other = await listen(path.join(short, "work/agent.4242"));
      const folder = path.dirname(agent);
      expect(
        await connect("codex", [agent, other], {}, [[folder, path.join(short, "work/ssh")]]),
      ).toEqual({ [agent]: "EPERM", [folder]: "EPERM", [other]: "reached" });
    });

    it("is out of reach where main's env names it, and stays where it is", async () => {
      const agent = await listen(path.join(short, "agent/ssh.sock"));
      const listeners = await listen(path.join(launchd, "Listeners"));
      const away = path.join(short, "work/moved.sock");
      mkdirSync(path.dirname(away));
      expect(await connect("claude", [agent], { sshAgent: agent })).toEqual({ [agent]: "EPERM" });
      expect(await connect("claude", [agent])).toEqual({ [agent]: "reached" });
      expect(
        await connect("claude", [listeners], { sshAgent: agent }, [
          [agent, away],
          [listeners, path.join(short, "work/listeners.sock")],
          [launchd, path.join(short, "work/launchd")],
        ]),
      ).toEqual({ [agent]: "EPERM", [launchd]: "EPERM", [listeners]: "EPERM" });
    });

    it("keeps a debug port on loopback out of reach, over IPv4 and IPv6 alike", async () => {
      const server = createServer();
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const { port } = z.object({ port: z.number() }).parse(server.address());
      const ipv6 = createServer();
      servers.push(ipv6);
      ipv6.listen(port, "::1");
      await once(ipv6, "listening");
      const targets = [`127.0.0.1#${port}`, `::1#${port}`, `localhost#${port}`];
      expect(await connect("codex", targets, { debugPorts: [port] })).toEqual(
        all(targets, "EPERM"),
      );
      expect(await connect("codex", targets.slice(0, 2))).toEqual(
        all(targets.slice(0, 2), "reached"),
      );
    });
  });

  it("passes the boot check, and fails it when the canary is readable, a stray write lands or the profile breaks", async () => {
    const sealed = await seal();
    expect(await checkSeal(sealed)).toBeNull();
    expect(await checkSeal(sealed, under("(version 1)\n(allow default)"))).toContain(
      "let a run read a file it seals",
    );
    expect(
      await checkSeal(
        sealed,
        under('(version 1)\n(allow default)\n(deny file-read* (regex #"/secrets\\.json$"))'),
      ),
    ).toContain("let a run write outside its own folders");
    expect(await checkSeal(sealed, under("(version 1)\n(allow nonsense)"))).toContain(
      "could not start inside IdleBiz's sandbox",
    );
  });
});

describe.skipIf(!onMac)("sealRuns", () => {
  let box = "";
  const touched = ["HOME", "PATH", "CLAUDE_BIN", "CODEX_BIN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
  const previous = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    box = realpathSync(mkdtempSync(path.join(tmpdir(), "idlebiz-home-")));
    process.env.PATH = path.join(box, "no-bin");
    process.env.HOME = path.join(box, "home");
    mkdirSync(path.join(box, "home"));
    for (const key of ["CLAUDE_BIN", "CODEX_BIN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
      // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
      delete process.env[key];
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
    rmSync(box, { force: true, recursive: true });
  });

  it("seals this machine's runs with its home, its temp folders and the save, each where it resolves", async () => {
    const home = path.join(box, "home");
    mkdirSync(path.join(box, "dotfiles/claude"), { recursive: true });
    symlinkSync(path.join(box, "dotfiles/claude"), path.join(home, ".claude"));
    expect(await sealRuns()).toEqual({ kind: "sealed" });
    const seal = await machineSeal([path.join(root, "acme/workspace")]);
    expect(seal.runners.claude.state).toEqual([
      { match: "prefix", path: path.join(home, ".claude") },
      { match: "prefix", path: path.join(box, "dotfiles/claude") },
    ]);
    expect(seal.runners.claude.config).toContainEqual({
      match: "prefix",
      path: path.join(box, "dotfiles/claude/settings"),
    });
    expect(seal.unreadable).toContainEqual({
      match: "prefix",
      path: path.join(realpathSync(root), "secrets.json"),
    });
    expect(seal.scratch).toEqual(
      expect.arrayContaining([
        { match: "subpath", path: "/private/tmp" },
        { match: "subpath", path: realpathSync(tmpdir()) },
      ]),
    );
    expect(seal.writable).toEqual([
      { match: "subpath", path: path.join(realpathSync(root), "acme/workspace") },
    ]);
    expect(seal.debugPorts).toEqual([9222, 9229]);
    expect(seal.sockets).toEqual(
      expect.arrayContaining(
        ["/var/run/docker.sock", "/private/tmp/cc-socks", "/private/tmp/codex-browser-use"].map(
          (at) => ({ match: "subpath", path: at }),
        ),
      ),
    );
  });

  it("finds a runner's home where the founder moved it", async () => {
    const moved = path.join(box, "codex-home");
    process.env.CODEX_HOME = moved;
    const seal = await machineSeal([]);
    expect(seal.runners.codex.state).toEqual([{ match: "subpath", path: moved }]);
    expect(seal.runners.codex.config).toContainEqual({
      match: "prefix",
      path: path.join(moved, "config.toml"),
    });
  });

  it("keeps the PATH folders that lie in a folder a run writes, and only those", async () => {
    const shims = path.join(box, "shims");
    mkdirSync(shims);
    process.env.PATH = [shims, "/usr/bin", "node_modules/.bin"].join(path.delimiter);
    const { onPath } = await machineSeal([]);
    const kept = onPath.map(({ path: at }) => at);
    expect(kept).toContain(shims);
    expect(kept).not.toContain("/usr/bin");
    expect(kept).not.toContain("node_modules/.bin");
  });

  it("resolves the home as it stands each time, so a login linked away since is sealed where it leads", async () => {
    const home = path.join(box, "home");
    const away = path.join(box, "external/aws");
    mkdirSync(away, { recursive: true });
    const before = await machineSeal([]);
    symlinkSync(away, path.join(home, ".aws"));
    const after = await machineSeal([]);
    expect(before.unreadable).not.toContainEqual({ match: "subpath", path: away });
    expect(after.unreadable).toContainEqual({ match: "subpath", path: away });
  });
});

describe("realPathOf", () => {
  let box = "";
  beforeEach(() => {
    box = realpathSync(mkdtempSync(path.join(tmpdir(), "idlebiz-real-")));
  });
  afterEach(() => {
    rmSync(box, { force: true, recursive: true });
  });

  it("follows every symlink on the way, and keeps what does not exist yet as named", async () => {
    mkdirSync(path.join(box, "elsewhere"));
    symlinkSync(path.join(box, "elsewhere"), path.join(box, "link"));
    expect(await realPathOf(path.join(box, "link"))).toBe(path.join(box, "elsewhere"));
    expect(await realPathOf(path.join(box, "link/new/file.html"))).toBe(
      path.join(box, "elsewhere/new/file.html"),
    );
    const linkedTmp = path.join(tmpdir(), path.basename(box));
    expect(await realPathOf(linkedTmp)).toBe(box);
  });
});
