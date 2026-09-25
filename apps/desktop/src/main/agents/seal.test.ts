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
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { LoadReport } from "@/shared/domain";
import { parseJson } from "@/shared/json";
import type { Seal, SealProbe } from "./seal";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-seal-root-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const { checkSeal, machineSeal, notingSeal, realPathOf, sealFor, sealRuns, sealedCommand } =
  await import("./seal");

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
  sshAgent: null,
  unreadable: [{ match: "subpath", path: "/Users/me/.idlebiz/secrets.json" }],
  unwritable: [{ match: "subpath", path: "/Users/me/.zshrc" }],
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
  /** The paths the profile's `(deny <operations> …)` rules name, in order. */
  const denied = (operations: string): string[] =>
    profile
      .split("\n")
      .filter((line) => line.startsWith(`(deny ${operations} (`))
      .flatMap((rule) => [...rule.matchAll(/\(param "(?<name>P\d+)"\)/gu)])
      .map(({ groups }) => params.get(groups?.name ?? "") ?? "");
  return { bin, denied, flag, params: [...params.values()], profile, runs: rest.slice(at) };
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

  it("keeps every folder above a sealed path from moving, and only those", () => {
    const { denied } = readBack(sealedCommand(SEAL, "codex", []));
    expect(denied("file-write-unlink")).toEqual(["/Users/me/.idlebiz", "/Users/me", "/Users"]);
  });

  it("names the ssh agent only when main's env had one", () => {
    const agent = "/private/tmp/com.apple.launchd.x/Listeners";
    const named = readBack(sealedCommand({ ...SEAL, sshAgent: agent }, "claude", []));
    expect(named.denied("network-outbound")).toEqual([agent]);
    expect(readBack(sealedCommand(SEAL, "claude", [])).denied("network-outbound")).toEqual([]);
  });

  it("leaves out a rule with nothing to reach, which would deny everything", () => {
    const bare: Seal = { ...SEAL, unwritable: [] };
    expect(readBack(sealedCommand(bare, "claude", [])).profile).not.toMatch(/\(deny [\w* -]+\)/u);
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

/** A real probe of the checked command, its profile swapped for `profile`. */
const under =
  (profile: string): SealProbe =>
  (argv, env) =>
    Promise.resolve(
      spawnSync(argv[0] ?? "", [argv[1] ?? "", profile, ...argv.slice(3)], { env }).status,
    );

/** What each file came to under the profile: "moved", "read", "written" or "ran", or the error that stopped it. */
const Outcomes = z.record(z.string(), z.string());

const TRY_FILES = `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [moves, reads, writes, runs] = JSON.parse(process.argv[1]);
const out = {};
for (const [from, to] of moves) { try { fs.renameSync(from, to); out[from] = "moved"; } catch (e) { out[from] = e.code; } }
for (const file of reads) { try { fs.readFileSync(file); out[file] = "read"; } catch (e) { out[file] = e.code; } }
for (const file of writes) { try { fs.appendFileSync(file, "x"); out[file] = "written"; } catch (e) { out[file] = e.code; } }
for (const bin of runs) { const r = spawnSync(bin, ["help"]); out[bin] = r.error ? r.error.code : "ran"; }
console.log(JSON.stringify(out));
`;

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
  const seal = (): Promise<Seal> =>
    sealFor({
      home,
      mainOnly: [at(".idlebiz/secrets.json"), at(".idlebiz/.push")],
      sshAgent: null,
    });
  const tryAs = async (
    runner: "claude" | "codex",
    files: { moves?: [string, string][]; reads?: string[]; writes?: string[]; runs?: string[] },
  ) => {
    const argv = sealedCommand(await seal(), runner, [
      process.execPath,
      "-e",
      TRY_FILES,
      JSON.stringify([files.moves ?? [], files.reads ?? [], files.writes ?? [], files.runs ?? []]),
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
      ".bashrc",
      ".bash_profile",
      ".profile",
      ".gitconfig",
      ".config/git/config",
      "Library/LaunchAgents/com.example.agent.plist",
    ].map(plant);
    expect(Object.values(await tryAs("claude", { reads: later }))).toEqual(later.map(() => "read"));
    expect(Object.values(await tryAs("claude", { writes: later }))).toEqual(
      later.map(() => "EPERM"),
    );
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
    const moved = at("work/ib/secrets.json");
    mkdirSync(at("work"));
    const moves: [string, string][] = [
      [at(".idlebiz"), at("work/ib")],
      [at("Library/Application Support/Google"), at("work/google")],
      [at("Library"), at("work/library")],
      [home, path.join(box, "moved-home")],
      [at(".idlebiz/acme"), at(".idlebiz/acme-renamed")],
    ];
    expect(await tryAs("codex", { moves, reads: [moved, secrets] })).toEqual({
      [at(".idlebiz")]: "EPERM",
      [at(".idlebiz/acme")]: "moved",
      [at("Library")]: "EPERM",
      [at("Library/Application Support/Google")]: "EPERM",
      [home]: "EPERM",
      [moved]: "ENOENT",
      [secrets]: "EPERM",
    });
  });

  it("leaves the run its workspace and the rest of home", async () => {
    const own = [
      plant(".idlebiz/acme/workspace/index.html"),
      plant(".idlebiz/cache/npm/_cacache/x"),
      plant(".agent-browser/default.sock.lock"),
      plant("Library/pnpm/store/x"),
    ];
    expect(await tryAs("codex", { reads: own, writes: own })).toEqual(
      Object.fromEntries(own.map((file) => [file, "written"])),
    );
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

  describe("an ssh agent", () => {
    let dir = "";
    let agent: Server | null = null;
    // a socket's path must fit in 104 bytes: tmpdir() on macOS alone takes half of that
    beforeEach(async () => {
      dir = realpathSync(mkdtempSync("/tmp/ib-"));
      const listening = createServer();
      agent = listening;
      listening.listen(path.join(dir, "agent.sock"));
      await once(listening, "listening");
    });
    afterEach(() => {
      agent?.close();
      rmSync(dir, { force: true, recursive: true });
    });

    // "connect" fires once the kernel queues it: this process, blocked in spawnSync, never accepts
    const CONNECT = `
const socket = require("node:net").connect(process.argv[1]);
socket.on("connect", () => { console.log("reached"); process.exit(0); });
socket.on("error", (error) => { console.log(error.code); process.exit(0); });
`;
    const connect = async (sshAgent: string | null): Promise<string> => {
      const socket = path.join(dir, "agent.sock");
      const sealed = await sealFor({
        home,
        mainOnly: [at(".idlebiz/secrets.json"), at(".idlebiz/.push")],
        sshAgent,
      });
      const argv = sealedCommand(sealed, "claude", [process.execPath, "-e", CONNECT, socket]);
      const [bin = "", ...args] = argv;
      return spawnSync(bin, args, { encoding: "utf-8" }).stdout.trim();
    };

    it("is out of reach when main's env names it", async () => {
      expect(await connect(path.join(dir, "agent.sock"))).toBe("EPERM");
      expect(await connect(null)).toBe("reached");
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
  const previousHome = process.env.HOME;
  beforeEach(() => {
    box = realpathSync(mkdtempSync(path.join(tmpdir(), "idlebiz-home-")));
  });
  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
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
    const seal = await machineSeal();
    expect(seal.unwritable).toEqual(
      expect.arrayContaining([
        { match: "subpath", path: path.join(home, ".zshrc") },
        { match: "subpath", path: path.join(box, "dotfiles/zshrc") },
      ]),
    );
    expect(seal.unreadable).toEqual(
      expect.arrayContaining([
        { match: "subpath", path: path.join(realpathSync(root), "secrets.json") },
        { match: "subpath", path: path.join(realpathSync(root), ".push") },
      ]),
    );
  });

  it("resolves the home as it stands each time, so a login linked away since is sealed where it leads", async () => {
    const home = path.join(box, "home");
    const away = path.join(box, "external/aws");
    mkdirSync(home);
    mkdirSync(away, { recursive: true });
    process.env.HOME = home;
    const before = await machineSeal();
    symlinkSync(away, path.join(home, ".aws"));
    const after = await machineSeal();
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
