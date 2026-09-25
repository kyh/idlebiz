import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  agents: [],
  guarded: [],
  otherLogin: {
    claude: [{ match: "prefix", path: "/Users/me/.codex" }],
    codex: [{ match: "prefix", path: "/Users/me/.claude" }],
  },
  unreadable: [{ match: "subpath", path: "/Users/me/.idlebiz/secrets.json" }],
  unwritable: [{ match: "subpath", path: "/Users/me/.zshrc" }],
  writable: [],
};

/** A sealed command read back: its profile, the paths it hands over, and what it runs. */
const readBack = (argv: readonly string[]) => {
  const [bin, flag, profile = "", ...rest] = argv;
  const params = new Map<string, string>();
  let at = 0;
  for (; rest[at] === "-D"; at += 2) {
    const define = rest[at + 1] ?? "";
    params.set(define.slice(0, define.indexOf("=")), define.slice(define.indexOf("=") + 1));
  }
  /** The paths the profile's `(<action> <operations> …)` rules name, in order. */
  const named = (action: "allow" | "deny", operations: string): string[] =>
    profile
      .split("\n")
      .filter((line) => line.startsWith(`(${action} ${operations} (`))
      .flatMap((rule) => [...rule.matchAll(/\(param "(?<name>P\d+)"\)/gu)])
      .map(({ groups }) => params.get(groups?.name ?? "") ?? "");
  const denied = (operations: string): string[] => named("deny", operations);
  const allowed = (operations: string): string[] => named("allow", operations);
  return {
    allowed,
    bin,
    denied,
    flag,
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

  it("seals each runner off from the other's login, and codex from the Keychain", () => {
    const claude = readBack(sealedCommand(SEAL, "claude", []));
    const codex = readBack(sealedCommand(SEAL, "codex", []));
    expect(claude.denied("file-read* file-write*")).toContain("/Users/me/.codex");
    expect(claude.params).not.toContain("/Users/me/.claude");
    expect(codex.denied("file-read* file-write*")).toContain("/Users/me/.claude");
    expect(codex.params).not.toContain("/Users/me/.codex");
    expect(codex.profile).toContain('(deny process-exec (literal "/usr/bin/security"))');
    expect(claude.profile).not.toContain("/usr/bin/security");
    expect(claude.profile).toMatch(/\(prefix \(param "P\d+"\)\)/u);
  });

  it("keeps every folder above a sealed path from moving or being made, and only those", () => {
    const { denied } = readBack(sealedCommand(SEAL, "codex", []));
    expect(denied("file-write-create file-write-unlink")).toEqual([
      "/Users/me/.idlebiz",
      "/Users/me",
      "/Users",
    ]);
  });

  it("keeps each of the run's own folders in place once it reopens them", () => {
    const workspace = "/Users/me/.idlebiz/acme/workspace";
    const { denied, profile } = readBack(
      sealedCommand({ ...SEAL, writable: [{ match: "subpath", path: workspace }] }, "claude", []),
    );
    expect(denied("file-write-create file-write-unlink")).toEqual(
      expect.arrayContaining([workspace]),
    );
    const lines = profile.split("\n");
    const reopened = lines.findIndex((line) => line.startsWith("(allow file-write* ("));
    const kept = lines.findIndex((line) =>
      line.startsWith("(deny file-write-create file-write-unlink (literal"),
    );
    expect(reopened).toBeGreaterThan(-1);
    expect(reopened).toBeLessThan(kept);
  });

  it("lets no run or probe open anything through LaunchServices, and only a sign-in open the browser", () => {
    const opensNothing = "(deny lsopen)";
    for (const sealed of ["claude", "codex", "shell"] as const) {
      expect(readBack(sealedCommand(SEAL, sealed, [])).profile.split("\n")).toContain(opensNothing);
    }
    expect(readBack(signInCommand(SEAL, "claude", [])).profile.split("\n")).not.toContain(
      opensNothing,
    );
    expect(signInCommand(SEAL, "codex", []).slice(0, 2)).toEqual(
      sealedCommand(SEAL, "codex", []).slice(0, 2),
    );
  });

  it("keeps every agent's socket out of reach and in place, and every socket under a sealed path", () => {
    const agent = "/private/tmp/com.apple.launchd.x/Listeners";
    const named = readBack(
      sealedCommand({ ...SEAL, agents: [{ match: "subpath", path: agent }] }, "claude", []),
    );
    expect(named.denied("network-outbound")).toEqual([
      "/Users/me/.idlebiz/secrets.json",
      "/Users/me/.codex",
      agent,
    ]);
    expect(named.profile).toMatch(/^\(deny network-outbound \(remote unix-socket \(/mu);
    expect(named.denied("file-write*")).toContain(agent);
  });

  it("closes the save and the programs, reopens the run's own folders, then seals the rest inside them too", () => {
    const seal: Seal = {
      ...SEAL,
      guarded: [
        { match: "subpath", path: "/Users/me/.idlebiz" },
        { match: "subpath", path: "/Users/me/.local/bin" },
      ],
      writable: [{ match: "subpath", path: "/Users/me/.idlebiz/acme/workspace" }],
    };
    const { allowed, denied, profile } = readBack(sealedCommand(seal, "codex", []));
    expect(denied("file-write*")).toEqual(
      expect.arrayContaining(["/Users/me/.idlebiz", "/Users/me/.local/bin"]),
    );
    expect(allowed("file-write*")).toEqual(["/Users/me/.idlebiz/acme/workspace"]);
    const lines = profile.split("\n");
    const reopened = lines.findIndex((line) => line.startsWith("(allow file-write* ("));
    const closed = lines.findIndex((line) => line.startsWith("(deny file-write* (subpath"));
    const sealed = lines.findIndex((line) => line.startsWith("(deny file-read* file-write* ("));
    expect(closed).toBeGreaterThan(-1);
    expect(closed).toBeLessThan(reopened);
    expect(reopened).toBeLessThan(sealed);
  });

  it("seals the login shell's probe off from both runners' logins and the Keychain", () => {
    const { denied, profile } = readBack(sealedCommand(SEAL, "shell", []));
    expect(denied("file-read* file-write*")).toEqual(
      expect.arrayContaining(["/Users/me/.codex", "/Users/me/.claude"]),
    );
    expect(profile).toContain('(deny process-exec (literal "/usr/bin/security"))');
  });

  it("leaves out a rule with nothing to reach, which would reach everything", () => {
    const bare: Seal = { ...SEAL, unreadable: [], unwritable: [] };
    const lines = readBack(sealedCommand(bare, "claude", [])).profile.split("\n");
    // lsopen is denied whole on purpose: an app LaunchServices starts runs unsealed
    expect(lines.filter((line) => /^\((?:allow|deny) [\w* -]+\)$/u.test(line))).toEqual([
      "(allow default)",
      "(deny lsopen)",
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
  it("runs each runner's runtime under the profile against a canary, never the real keys", async () => {
    const seen: { argv: readonly string[]; env: Record<string, string> }[] = [];
    const refusal = await checkSeal(SEAL, (argv, env) => {
      seen.push({ argv, env });
      return Promise.resolve(0);
    });
    expect(refusal).toBeNull();
    expect(seen).toHaveLength(2);
    for (const { argv, env } of seen) {
      const { denied, runs } = readBack(argv);
      const canary = runs.at(-1) ?? "";
      expect(canary).not.toBe("/Users/me/.idlebiz/secrets.json");
      expect(denied("file-read* file-write*")).toContain(canary);
      expect(denied("file-read* file-write*")).toContain("/Users/me/.idlebiz/secrets.json");
      expect(runs[0]).toBe(process.execPath);
      expect(env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
      expect(existsSync(canary)).toBe(false);
    }
  });

  it.each([
    [null, "could not run macOS's sandbox-exec"],
    [3, "let a run read a file it seals"],
    [71, "(exit 71)"],
  ])("refuses every run when a probe ends %s", async (code, sentence) => {
    const refusal = await checkSeal(SEAL, (argv) =>
      Promise.resolve(argv.some((word) => word.includes("/usr/bin/security")) ? code : 0),
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
      home,
      mainOnly: [at(".idlebiz/secrets.json"), at(".idlebiz/.push")],
      pathDirs: [],
      programs: [],
      save: at(".idlebiz"),
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
    "Library/Application Support/Google/Chrome/Default/Cookies",
    "Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies",
    "Library/Cookies/Cookies.binarycookies",
    ".idlebiz/secrets.json",
    ".idlebiz/.push/repo-1/config",
  ];

  it.each(["claude", "codex"] as const)(
    "keeps the founder's logins, IdleBiz's keys and where it stages a push from a %s run, reads and writes alike",
    async (runner) => {
      const files = LOGINS.map(plant);
      const outcomes = await tryAs(runner, { reads: files });
      expect(outcomes).toEqual(Object.fromEntries(files.map((file) => [file, "EPERM"])));
      expect(Object.values(await tryAs(runner, { writes: files }))).toEqual(
        files.map(() => "EPERM"),
      );
    },
  );

  it("keeps each runner's own login and seals the other's, where a symlink leads too", async () => {
    const codexLogin = plant(".codex/auth.json");
    const claudeDir = plant(".claude/settings.json");
    const claudeState = at(".claude.json");
    const claudeStateTarget = link(".claude.json", "dotfiles/claude.json");
    const reads = [codexLogin, claudeState, claudeStateTarget, claudeDir];
    expect(await tryAs("claude", { reads })).toEqual({
      [claudeDir]: "read",
      [claudeState]: "read",
      [claudeStateTarget]: "read",
      [codexLogin]: "EPERM",
    });
    expect(await tryAs("codex", { reads })).toEqual({
      [claudeDir]: "EPERM",
      [claudeState]: "EPERM",
      [claudeStateTarget]: "EPERM",
      [codexLogin]: "read",
    });
  });

  it("lets a run read the founder's config but not rewrite what runs as them later", async () => {
    const later = [
      ".zshrc",
      ".zshenv",
      ".zprofile",
      ".zlogin",
      ".zlogout",
      ".zsh_sessions/A1B2.session",
      ".bashrc",
      ".bash_profile",
      ".bash_login",
      ".bash_logout",
      ".bash_sessions/A1B2.session",
      ".profile",
      ".inputrc",
      ".gitconfig",
      ".config/git/config",
      "Library/LaunchAgents/com.example.agent.plist",
    ].map(plant);
    expect(Object.values(await tryAs("claude", { reads: later }))).toEqual(later.map(() => "read"));
    expect(Object.values(await tryAs("claude", { writes: later }))).toEqual(
      later.map(() => "EPERM"),
    );
  });

  it("keeps zsh's startup files, compiled or not, wherever ZDOTDIR puts them", async () => {
    const zdotdir = [
      "dots/zsh/.zshrc",
      "dots/zsh/.zshenv",
      "dots/zsh/.zlogout",
      "dots/zsh/.zsh_sessions/A1B2.session",
    ].map(plant);
    const compiled = [".zshrc.zwc", "dots/zsh/.zprofile.zwc"].map(at);
    const notes = [at("dots/zsh/zshrc.md"), at("dots/zsh/.zsh_history")];
    expect(await tryAs("codex", { writes: [...zdotdir, ...compiled, ...notes] })).toEqual({
      ...Object.fromEntries([...zdotdir, ...compiled].map((file) => [file, "EPERM"])),
      ...Object.fromEntries(notes.map((file) => [file, "written"])),
    });
  });

  it("seals a symlinked dotfile where it leads, as a dotfile manager sets them up", async () => {
    const zshrc = link(".zshrc", "dotfiles/zshrc");
    const gitconfig = link(".gitconfig", "dotfiles/gitconfig");
    link(".config", "dotfiles/config/");
    const gitConfig = plant("dotfiles/config/git/config");
    const ghLogin = plant("dotfiles/config/gh/hosts.yml");
    const npmrc = link(".npmrc", "dotfiles/npmrc");
    link(".aws", "dotfiles/aws/");
    const aws = plant("dotfiles/aws/credentials");
    const named = [".zshrc", ".gitconfig", ".config/git/config"].map(at);
    const targets = [zshrc, gitconfig, gitConfig];
    expect(Object.values(await tryAs("codex", { writes: [...named, ...targets] }))).toEqual(
      [...named, ...targets].map(() => "EPERM"),
    );
    expect(Object.values(await tryAs("codex", { reads: [...named, ...targets] }))).toEqual(
      [...named, ...targets].map(() => "read"),
    );
    expect(await tryAs("codex", { reads: [npmrc, aws, ghLogin] })).toEqual({
      [aws]: "EPERM",
      [ghLogin]: "EPERM",
      [npmrc]: "EPERM",
    });
    expect(await tryAs("codex", { moves: [[at("dotfiles"), at("elsewhere")]] })).toEqual({
      [at("dotfiles")]: "EPERM",
    });
  });

  it("keeps every folder above a sealed path in place, so nothing moves out from under its rule", async () => {
    const secrets = plant(".idlebiz/secrets.json");
    plant(".idlebiz/acme/workspace/index.html");
    plant("Library/Application Support/Google/Chrome/Default/Cookies");
    plant("projects/app/index.html");
    const moved = at("work/ib/secrets.json");
    mkdirSync(at("work"));
    const moves: [string, string][] = [
      [at(".idlebiz"), at("work/ib")],
      [at("Library/Application Support/Google"), at("work/google")],
      [at("Library"), at("work/library")],
      [home, path.join(box, "moved-home")],
      [at(".idlebiz/acme"), at(".idlebiz/acme-renamed")],
      [at("projects/app"), at("projects/app-renamed")],
    ];
    expect(await tryAs("codex", { moves, reads: [moved, secrets] })).toEqual({
      [at(".idlebiz")]: "EPERM",
      [at(".idlebiz/acme")]: "EPERM",
      [at("Library")]: "EPERM",
      [at("Library/Application Support/Google")]: "EPERM",
      [at("projects/app")]: "moved",
      [home]: "EPERM",
      [moved]: "ENOENT",
      [secrets]: "EPERM",
    });
  });

  it("leaves the run its own folders in the save and the rest of home", async () => {
    const mine = [
      plant(".idlebiz/acme/workspace/index.html"),
      plant(".idlebiz/acme/workspace/node_modules/.bin/vite"),
      plant(".idlebiz/acme/agents/ann/memory/notes.md"),
      plant(".idlebiz/cache/npm/_cacache/x"),
      plant(".idlebiz/cache/pnpm-store/v10/x"),
      plant(".agent-browser/default.sock.lock"),
      plant("Library/pnpm/store/x"),
    ];
    expect(await tryAs("codex", { reads: mine, writes: mine })).toEqual(
      Object.fromEntries(mine.map((file) => [file, "written"])),
    );
  });

  it("keeps the rest of the save from a run, so it forges no approval, verdict or teammate", async () => {
    const workspace = plant(".idlebiz/acme/workspace/index.html");
    const memory = plant(".idlebiz/acme/agents/ann/memory/notes.md");
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
        writes: [workspace, memory, ...forged],
      }),
    ).toEqual({
      ...Object.fromEntries(forged.map((file) => [file, "EPERM"])),
      [linked]: "EPERM",
      [memory]: "written",
      [workspace]: "written",
    });
    expect(await tryAs("claude", { writes: [workspace, memory] }, seal({ writable: [] }))).toEqual({
      [memory]: "EPERM",
      [workspace]: "EPERM",
    });
  });

  it("keeps a run from making or reading a sibling of secrets.json, where the save is named and where it leads", async () => {
    link(".idlebiz", "elsewhere/idlebiz/");
    const stale = plant("elsewhere/idlebiz/secrets.json.tmp");
    const named = [at(".idlebiz/secrets.json.tmp")];
    const resolved = [stale];
    const fresh = [at(".idlebiz/secrets.json.old"), at("elsewhere/idlebiz/secrets.json.new")];
    expect(await tryAs("codex", { reads: [...named, ...resolved] })).toEqual({
      [at(".idlebiz/secrets.json.tmp")]: "EPERM",
      [stale]: "EPERM",
    });
    expect(
      Object.values(
        await tryAs("codex", { writes: fresh }, seal({ save: at("unused"), writable: [] })),
      ),
    ).toEqual(fresh.map(() => "EPERM"));
  });

  it("keeps a run from changing a program main or the founder runs later, through any link to it", async () => {
    const claude = link(".local/bin/claude", ".local/share/claude/versions/1.0.0");
    const node = "fnm/v24/installation";
    mkdirSync(at(`${node}/bin`), { recursive: true });
    mkdirSync(at("multishells"));
    symlinkSync(at(node), at("multishells/42"));
    const codexJs = plant(`${node}/lib/node_modules/@openai/codex/bin/codex.js`);
    const vendored = plant(
      `${node}/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/codex`,
    );
    const otherPackage = plant(`${node}/lib/node_modules/typescript/bin/tsc`);
    symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", at(`${node}/bin/codex`));
    // a shim first on PATH that runs the next codex, as a version manager's does
    const shim = plant(".local/bin/codex");
    spawnSync("chmod", ["+x", claude, codexJs, shim]);
    const sealed = seal({
      clis: ["claude", "codex"],
      pathDirs: [at(".local/bin"), at("multishells/42/bin"), "node_modules/.bin"],
    });
    const writes = [
      at(".local/bin/rg"),
      shim,
      claude,
      at(".local/share/claude/versions/9.9.9"),
      at("multishells/42/bin/codex"),
      at("multishells/42/bin/npm"),
      at(`${node}/bin/npx`),
      codexJs,
      vendored,
      otherPackage,
    ];
    const moves: [string, string][] = [
      [at(".local/bin/claude"), at(".local/bin/claude-old")],
      [at("multishells/42"), at("multishells/43")],
      [at(".local/share/claude"), at(".local/share/claude-old")],
      [at(`${node}/lib`), at(`${node}/lib-old`)],
    ];
    const outcomes = await tryAs("claude", { moves, writes }, sealed);
    expect(outcomes).toEqual(
      Object.fromEntries(
        [...writes, ...moves.map(([from]) => from)].map((file) => [file, "EPERM"]),
      ),
    );
    const mine = [
      plant(".idlebiz/acme/workspace/node_modules/.bin/vite"),
      plant(".idlebiz/cache/npm/_cacache/index-v5/x"),
      plant(".local/share/other-tool/state.json"),
    ];
    expect(Object.values(await tryAs("claude", { writes: mine }, sealed))).toEqual(
      mine.map(() => "written"),
    );
  });

  it("keeps a run from changing whatever a PATH folder links to, as Homebrew and npm set them up", async () => {
    const gh = plant("brew/Cellar/gh/1.0/bin/gh");
    mkdirSync(at("brew/bin"), { recursive: true });
    symlinkSync("../Cellar/gh/1.0/bin/gh", at("brew/bin/gh"));
    const pcre = plant("brew/Cellar/pcre2/10.0/lib/libpcre2.dylib");
    mkdirSync(at("brew/opt"));
    symlinkSync("../Cellar/pcre2/10.0", at("brew/opt/pcre2"));
    const tsc = plant("node/v24/lib/node_modules/typescript/bin/tsc");
    mkdirSync(at("node/v24/bin"), { recursive: true });
    symlinkSync("../lib/node_modules/typescript/bin/tsc", at("node/v24/bin/tsc"));
    symlinkSync("../share/later/bin/later", at("node/v24/bin/later"));
    mkdirSync(at("node/v24/share"));
    const script = link(".local/bin/hello", "hello.sh");
    mkdirSync(at("brew/etc"));
    const sealed = await seal({
      pathDirs: [at("brew/bin"), at("node/v24/bin"), at(".local/bin")],
    });
    const dirs = [at("node/v24/share/later/bin"), at("brew/lib/python3.13/site-packages")];
    const symlinks: [string, string][] = [
      [at(".idlebiz/acme/workspace"), at("brew/opt/pcre2-next")],
    ];
    const writes = [
      at("brew/bin/new"),
      at("brew/bin/gh"),
      gh,
      at("brew/opt/pcre2/lib/libpcre2.dylib"),
      pcre,
      at("brew/etc/gitconfig"),
      at("node/v24/bin/tsc"),
      tsc,
      at("node/v24/lib/node_modules/evil.js"),
      at(".local/bin/hello"),
      script,
    ];
    expect(await tryAs("codex", { dirs, symlinks, writes }, Promise.resolve(sealed))).toEqual(
      Object.fromEntries(
        [...dirs, ...symlinks.map(([, to]) => to), ...writes].map((file) => [file, "EPERM"]),
      ),
    );
    expect(sealed.guarded).toContainEqual({ match: "subpath", path: at("brew") });
    expect(sealed.guarded.filter(({ path: kept }) => kept.startsWith(at("brew/")))).toEqual([]);
    expect(sealed.guarded).not.toContainEqual({ match: "subpath", path: home });
    const mine = [
      plant(".idlebiz/acme/workspace/node_modules/typescript/bin/tsc"),
      plant(".idlebiz/cache/npm/_cacache/index-v5/x"),
      plant(".idlebiz/cache/pnpm-store/v10/x"),
      plant("Library/pnpm/store/x"),
      plant(".local/share/other-tool/state.json"),
      at("notes.md"),
    ];
    expect(Object.values(await tryAs("codex", { writes: mine }, Promise.resolve(sealed)))).toEqual(
      mine.map(() => "written"),
    );
  });

  it.each(["claude", "codex"] as const)(
    "keeps a %s run from changing IdleBiz itself, which the founder relaunches unsealed",
    async (runner) => {
      const bundle = path.join(box, "Applications/IdleBiz.app");
      const inBundle = (file: string): string => path.join(bundle, "Contents", file);
      for (const file of [
        "MacOS/IdleBiz",
        "Resources/app.asar",
        "Resources/app.asar.unpacked/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
        "Frameworks/Electron Framework.framework/Electron Framework",
      ]) {
        mkdirSync(path.dirname(inBundle(file)), { recursive: true });
        writeFileSync(inBundle(file), "canary");
      }
      const sealed = seal({
        programs: [
          inBundle("MacOS/IdleBiz"),
          inBundle("Resources/app.asar/.output/app/main/index.js"),
        ],
      });
      const writes = [
        inBundle("MacOS/IdleBiz"),
        inBundle("Resources/app.asar"),
        inBundle(
          "Resources/app.asar.unpacked/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
        ),
        inBundle("Frameworks/Electron Framework.framework/Electron Framework"),
        inBundle("Resources/app.asar.new"),
      ];
      const replaced = inBundle("Resources/app.asar");
      const outcomes = await tryAs(
        runner,
        {
          moves: [
            [bundle, path.join(box, "Applications/Old.app")],
            [inBundle("MacOS/IdleBiz"), inBundle("MacOS/IdleBiz.old")],
          ],
          removes: [replaced],
          writes,
        },
        sealed,
      );
      expect(outcomes).toEqual(
        Object.fromEntries(
          [bundle, inBundle("MacOS/IdleBiz"), ...writes].map((file) => [file, "EPERM"]),
        ),
      );
      expect(existsSync(replaced)).toBe(true);
    },
  );

  it("keeps a run from starting an app through LaunchServices, which would run it unsealed", async () => {
    const app = at("work/Canary.app");
    const launched = at("work/launched");
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

  it("lets a run and the shell probe list processes, as version managers do to find their shell", async () => {
    const sealed = await seal();
    for (const command of [
      sealedCommand(sealed, "claude", ["/bin/ps", "-p", "1", "-o", "pid="]),
      sealedCommand(sealed, "shell", ["/bin/ps", "-p", "1", "-o", "pid="]),
    ]) {
      expect(exitOf(command)).toBe(0);
    }
  });

  it("keeps a run from the CLIs that drive other apps, which a sign-in may still run", async () => {
    const sealed = await seal();
    const script = ["/usr/bin/osascript", "-e", "return 1"];
    expect(exitOf(sealedCommand(sealed, "codex", script))).not.toBe(0);
    expect(exitOf(signInCommand(sealed, "codex", script))).toBe(0);
  });

  it("keeps a run from changing IdleBiz in dev: the whole checkout main is built and relaunched from", async () => {
    const checkout = path.join(box, "checkout");
    const inCheckout = (file: string): string => path.join(checkout, file);
    const electron = inCheckout(
      "node_modules/.pnpm/electron@1.0.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    const sharp = inCheckout("node_modules/.pnpm/sharp@1.0.0/node_modules/sharp/lib/index.js");
    const app = [
      "apps/desktop/package.json",
      "apps/desktop/.output/app/main/index.js",
      "apps/desktop/.output/app/preload/index.js",
      "apps/desktop/.output/app/renderer/index.html",
      "apps/desktop/src/main/index.ts",
      "packages/agent-driver/package.json",
      "packages/agent-driver/src/detect.ts",
      "package.json",
      "pnpm-workspace.yaml",
      "turbo.json",
    ].map(inCheckout);
    for (const file of [electron, sharp, ...app]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "canary");
    }
    mkdirSync(inCheckout("apps/desktop/node_modules/@repo"), { recursive: true });
    symlinkSync(path.dirname(path.dirname(sharp)), inCheckout("apps/desktop/node_modules/sharp"));
    symlinkSync(
      inCheckout("packages/agent-driver"),
      inCheckout("apps/desktop/node_modules/@repo/agent-driver"),
    );
    const linked = inCheckout("apps/desktop/node_modules/sharp/lib/index.js");
    const linkedSource = inCheckout("apps/desktop/node_modules/@repo/agent-driver/src/detect.ts");
    const main = inCheckout("apps/desktop/.output/app/main/index.js");
    const writes = [electron, sharp, linked, linkedSource, ...app];
    const outcomes = await tryAs("codex", { writes }, seal({ programs: [electron, main] }));
    expect(outcomes).toEqual(Object.fromEntries(writes.map((file) => [file, "EPERM"])));
  });

  it("never guards home itself for a program with no package above it short of home", async () => {
    plant("package.json");
    const main = plant("tools/idlebiz/main/index.js");
    const sealed = await seal({ programs: [main] });
    expect(sealed.guarded).toContainEqual({ match: "subpath", path: at("tools/idlebiz/main") });
    expect(sealed.guarded).not.toContainEqual({ match: "subpath", path: home });
  });

  it("keeps a run from swapping a folder of its own for a link, so the next run's seal holds too", async () => {
    const forged = [
      plant(".idlebiz/acme/approvals.json"),
      plant(".idlebiz/acme/bets/more-users/BET.md"),
      plant(".local/bin/claude"),
    ];
    const memory = path.dirname(plant(".idlebiz/acme/agents/ann/memory/notes.md"));
    const cache = at(".idlebiz/cache");
    plant(".idlebiz/cache/npm/x");
    const swap = at(".idlebiz/acme/workspace/swap");
    plant(".idlebiz/acme/workspace/swap/bin/claude");
    const more = { pathDirs: [at(".local/bin")] };
    const first = seal(more);
    expect(await tryAs("codex", { removes: [memory, cache] }, first)).toEqual({
      [cache]: "EPERM",
      [memory]: "EPERM",
    });
    expect(existsSync(at(".idlebiz/cache/npm"))).toBe(false);
    const moves: [string, string][] = [
      [memory, at(".idlebiz/acme/workspace/memory")],
      [swap, cache],
    ];
    expect(await tryAs("codex", { moves }, first)).toEqual({
      [memory]: "EPERM",
      [swap]: "EPERM",
    });
    const symlinks: [string, string][] = [
      [at(".idlebiz"), path.join(memory, "save")],
      [at(".local/bin"), path.join(cache, "bin")],
    ];
    expect(Object.values(await tryAs("codex", { symlinks }, first))).toEqual(["linked", "linked"]);
    const next = seal(more);
    expect(
      await tryAs("codex", { writes: [...forged, path.join(memory, "notes.md")] }, next),
    ).toEqual({
      ...Object.fromEntries(forged.map((file) => [file, "EPERM"])),
      [path.join(memory, "notes.md")]: "written",
    });
    expect(
      await tryAs("codex", { writes: [path.join(memory, "save/acme/approvals.json")] }, next),
    ).toEqual({ [path.join(memory, "save/acme/approvals.json")]: "EPERM" });
  });

  it("starts no run whose folder is a link or lies outside the save", async () => {
    mkdirSync(at(".idlebiz/acme/workspace"), { recursive: true });
    mkdirSync(at(".idlebiz/cache"));
    mkdirSync(at("elsewhere/ann"), { recursive: true });
    await expect(seal()).resolves.toBeDefined();
    const ann = at(".idlebiz/acme/agents/ann");
    const memory = path.join(ann, "memory");
    mkdirSync(ann, { recursive: true });
    symlinkSync(at(".idlebiz"), memory);
    await expect(seal()).rejects.toThrow(`while ${memory} is a symlink`);
    rmSync(ann, { recursive: true });
    symlinkSync(at("elsewhere/ann"), ann);
    await expect(seal()).rejects.toThrow(`while ${ann} is a symlink`);
    for (const folder of [at("projects/app"), at(".idlebiz")]) {
      await expect(seal({ writable: [folder] })).rejects.toThrow("no folder inside the save");
    }
  });

  it("keeps a run from making a folder the founder's PATH names before it exists", async () => {
    const bun = at(".bun/bin");
    const sealed = seal({ pathDirs: [bun] });
    const made = path.dirname(path.dirname(plant(".idlebiz/acme/workspace/made/bin/claude")));
    expect(
      await tryAs(
        "codex",
        {
          dirs: [bun, at(".cache/tool")],
          moves: [[made, at(".bun")]],
          symlinks: [[made, at(".bun")]],
          writes: [path.join(bun, "claude")],
        },
        sealed,
      ),
    ).toEqual({
      [at(".bun")]: "EPERM",
      [at(".cache/tool")]: "made",
      [bun]: "EPERM",
      [path.join(bun, "claude")]: "ENOENT",
      [made]: "EPERM",
    });
    expect(existsSync(at(".bun"))).toBe(false);
  });

  it("stops the Keychain's git helper for every run and the Keychain's CLI for codex's", async () => {
    const helper = plant("bin/git-credential-osxkeychain");
    spawnSync("chmod", ["+x", helper]);
    const runs = [helper, "/usr/bin/security"];
    expect(await tryAs("codex", { runs })).toEqual({
      "/usr/bin/security": "EPERM",
      [helper]: "EPERM",
    });
    expect(await tryAs("claude", { runs })).toEqual({
      "/usr/bin/security": "ran",
      [helper]: "EPERM",
    });
  });

  describe("an agent's socket", () => {
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
const [sockets, moves] = JSON.parse(process.argv[1]);
const out = {};
for (const [from, to] of moves) { try { fs.renameSync(from, to); out[from] = "moved"; } catch (e) { out[from] = e.code; } }
let left = sockets.length;
const done = (socket, outcome) => { out[socket] = outcome; if (--left === 0) { console.log(JSON.stringify(out)); process.exit(0); } };
for (const socket of sockets) {
  const connection = net.connect(socket);
  connection.on("connect", () => done(socket, "reached"));
  connection.on("error", (error) => done(socket, error.code));
}
`;
    const connect = async (
      sshAgent: string | null,
      sockets: readonly string[],
      moves: readonly [string, string][] = [],
    ) => {
      const sealed = await sealFor({
        clis: [],
        home: short,
        mainOnly: [],
        pathDirs: [],
        programs: [],
        save: path.join(short, ".idlebiz"),
        sshAgent,
        writable: [],
      });
      const argv = sealedCommand(sealed, "claude", [
        process.execPath,
        "-e",
        CONNECT,
        JSON.stringify([sockets, moves]),
      ]);
      const [bin = "", ...args] = argv;
      return Outcomes.parse(parseJson(spawnSync(bin, args, { encoding: "utf-8" }).stdout));
    };

    it("is out of reach under a sealed folder, while one in the workspace answers", async () => {
      const sockets = await Promise.all(
        [
          ".ssh/agent.sock",
          ".gnupg/S.gpg-agent.ssh",
          "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
          "work/app.sock",
        ].map((name) => listen(path.join(short, name))),
      );
      const [ssh = "", gpg = "", onePassword = "", workspace = ""] = sockets;
      expect(await connect(null, sockets)).toEqual({
        [gpg]: "EPERM",
        [onePassword]: "EPERM",
        [ssh]: "EPERM",
        [workspace]: "reached",
      });
    });

    it("is out of reach where an ssh-agent started from a terminal names it, wherever its TMPDIR is", async () => {
      const agent = await listen(path.join(short, "ssh-AbC123/agent.4242"));
      const other = await listen(path.join(short, "work/agent.4242"));
      expect(await connect(null, [agent, other])).toEqual({
        [agent]: "EPERM",
        [other]: "reached",
      });
    });

    it("is out of reach where main's env names it, and stays where it is", async () => {
      const agent = await listen(path.join(short, "agent/ssh.sock"));
      const listeners = await listen(path.join(launchd, "Listeners"));
      const away = path.join(short, "work/moved.sock");
      mkdirSync(path.dirname(away));
      expect(await connect(agent, [agent])).toEqual({ [agent]: "EPERM" });
      expect(await connect(null, [agent])).toEqual({ [agent]: "reached" });
      expect(
        await connect(
          agent,
          [listeners],
          [
            [agent, away],
            [listeners, path.join(short, "work/listeners.sock")],
            [launchd, path.join(short, "work/launchd")],
          ],
        ),
      ).toEqual({ [agent]: "EPERM", [launchd]: "EPERM", [listeners]: "EPERM" });
    });
  });

  it("passes the boot check, and fails it when the canary is readable or the profile breaks", async () => {
    const sealed = await seal();
    expect(await checkSeal(sealed)).toBeNull();
    expect(await checkSeal(sealed, under("(version 1)\n(allow default)"))).toContain(
      "let a run read a file it seals",
    );
    expect(await checkSeal(sealed, under("(version 1)\n(allow nonsense)"))).toContain(
      "could not start inside IdleBiz's sandbox",
    );
  });
});

describe.skipIf(!onMac)("sealRuns", () => {
  let box = "";
  const touched = ["HOME", "PATH", "CLAUDE_BIN", "CODEX_BIN"];
  const previous = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    box = realpathSync(mkdtempSync(path.join(tmpdir(), "idlebiz-home-")));
    process.env.PATH = path.join(box, "no-bin");
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

  it("seals this machine's runs with its home and save, each where it resolves", async () => {
    const home = path.join(box, "home");
    mkdirSync(path.join(box, "dotfiles"), { recursive: true });
    mkdirSync(home);
    writeFileSync(path.join(box, "dotfiles/zshrc"), "canary");
    symlinkSync(path.join(box, "dotfiles/zshrc"), path.join(home, ".zshrc"));
    process.env.HOME = home;
    expect(await sealRuns()).toEqual({ kind: "sealed" });
    const seal = await machineSeal([]);
    expect(seal.unwritable).toEqual(
      expect.arrayContaining([
        { match: "subpath", path: path.join(home, ".zshrc") },
        { match: "subpath", path: path.join(box, "dotfiles/zshrc") },
      ]),
    );
    expect(seal.unreadable).toEqual(
      expect.arrayContaining([
        { match: "prefix", path: path.join(realpathSync(root), "secrets.json") },
        { match: "prefix", path: path.join(realpathSync(root), ".push") },
      ]),
    );
  });

  it("guards main's PATH, the CLIs it finds there, IdleBiz itself and the save, but for the run's own folders", async () => {
    const bin = path.join(box, "bin");
    const versions = path.join(box, "claude/versions");
    mkdirSync(path.join(box, "home"));
    mkdirSync(bin);
    mkdirSync(versions, { recursive: true });
    writeFileSync(path.join(versions, "1.0.0"), "", { mode: 0o755 });
    symlinkSync(path.join(versions, "1.0.0"), path.join(bin, "claude"));
    process.env.HOME = path.join(box, "home");
    process.env.PATH = [bin, "node_modules/.bin"].join(path.delimiter);
    delete process.env.CLAUDE_BIN;
    delete process.env.CODEX_BIN;
    const workspace = path.join(root, "acme/workspace");
    const seal = await machineSeal([workspace]);
    expect(seal.guarded).toEqual(
      expect.arrayContaining([
        { match: "subpath", path: root },
        { match: "subpath", path: bin },
        { match: "subpath", path: versions },
      ]),
    );
    expect(seal.guarded).not.toContainEqual({ match: "subpath", path: "node_modules/.bin" });
    // in dev, the whole checkout: main is built from every package in it
    expect(seal.guarded).toContainEqual({
      match: "subpath",
      path: path.resolve(import.meta.dirname, "../../../../.."),
    });
    const executable = realpathSync(process.execPath);
    expect(seal.guarded.some(({ path: at }) => executable.startsWith(`${at}${path.sep}`))).toBe(
      true,
    );
    expect(seal.writable).toEqual([
      { match: "subpath", path: path.join(realpathSync(root), "acme/workspace") },
    ]);
  });

  it("resolves the home as it stands each time, so a login linked away since is sealed where it leads", async () => {
    const home = path.join(box, "home");
    const away = path.join(box, "external/aws");
    mkdirSync(home);
    mkdirSync(away, { recursive: true });
    process.env.HOME = home;
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
