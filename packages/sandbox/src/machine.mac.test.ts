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
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJson } from "@repo/domain/json";
import type { RunnerId } from "@repo/domain/runners";
import { FolderRefusedError, browserNamespace, sandboxFor } from "./machine";
import { sandboxedCommand, signInCommand } from "./profile";
import type { Sandbox } from "./profile";
import { checkSandbox } from "./check";
import { watchDenials } from "./denials";
import type { Denial } from "./denials";
import type { SandboxProbe } from "./check";

const onMac = process.platform === "darwin";

// every test here starts real sandboxed processes, which take seconds each on a CI runner
vi.setConfig({ testTimeout: 30_000 });

/** How `argv` exited, run as it stands. */
const exitOf = (argv: readonly string[]): number | null => {
  const [bin = "", ...args] = argv;
  return spawnSync(bin, args, { encoding: "utf-8" }).status;
};

/** What `argv` printed, run as it stands with `input` on stdin; given up on after 20s, a hang too. */
const outputOf = (argv: readonly string[], input = ""): string => {
  const [bin = "", ...args] = argv;
  return spawnSync(bin, args, { encoding: "utf-8", input, timeout: 20_000 }).stdout;
};

/**
 * Whether a `runner` run under `sandboxed` starts a program at all: until it does, a canary that finds
 * nothing landed would pass on a profile that never compiled.
 */
const startsUnder = (sandboxed: Sandbox, runner: RunnerId): boolean =>
  exitOf(sandboxedCommand(sandboxed, runner, ["/usr/bin/true"])) === 0;

/** Every disk an `hdiutil attach` printed, for a cleanup to detach. */
const disksIn = (printed: string): string[] =>
  Array.from(printed.matchAll(/\/dev\/disk\d+/gu), ([disk]) => disk);

// the find pasteboard, which pboard serves over the one service as it does the general one, so the
// canary leaves what the founder copied alone
const PASTE = ["/usr/bin/pbpaste", "-pboard", "find"];
const COPY = ["/usr/bin/pbcopy", "-pboard", "find"];

// pbpaste answers only in a session with a window server, which CI's macOS runner has
const pasteboardAnswers =
  onMac && spawnSync(PASTE[0] ?? "", PASTE.slice(1), { timeout: 20_000 }).status === 0;

/** A real probe of the checked command, its profile swapped for `profile`. */
const under =
  (profile: string): SandboxProbe =>
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
  // home sits in a box of its own, so a rename the sandbox failed to stop is still cleaned up
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
  /** The folders a run on a product writes, which the runner pool hands it. */
  const own = () => [
    at(".idlebiz/company/products/ledger/workspace"),
    at(".idlebiz/company/agents/ann/memory"),
    at(".idlebiz/cache"),
    at(".idlebiz/company/shared"),
  ];
  const sandbox = (more: Partial<Parameters<typeof sandboxFor>[0]> = {}): Promise<Sandbox> =>
    sandboxFor({
      clis: [],
      closedPorts: [],
      env: {},
      home,
      hostOnly: [at(".idlebiz/vault.json")],
      pathDirs: [],
      save: at(".idlebiz"),
      scratch: [at("tmp")],
      shims: [],
      sshAgent: null,
      writable: own(),
      ...more,
    });
  const tryAs = async (
    runner: "claude" | "codex",
    files: Attempts,
    sandboxed: Promise<Sandbox> = sandbox(),
    command: typeof sandboxedCommand = sandboxedCommand,
  ) => {
    const argv = command(await sandboxed, runner, [
      process.execPath,
      "-e",
      TRY_FILES,
      JSON.stringify(files),
    ]);
    const [bin, ...args] = argv;
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
    ".config/hub",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".config/git/credentials",
    ".aws/credentials",
    ".azure/msal_token_cache.json",
    ".oci/config",
    ".kube/config",
    ".docker/config.json",
    ".gnupg/private-keys-v1.d/key",
    ".config/gcloud/credentials.db",
    "Library/Application Support/doctl/config.yaml",
    ".config/stripe/config.toml",
    ".wrangler/config/default.toml",
    ".config/.wrangler/config/default.toml",
    "Library/Preferences/.wrangler/config/default.toml",
    ".config/cloudflare/config/default.json",
    "Library/Preferences/cloudflare/config/default.json",
    ".config/netlify/config.json",
    "Library/Preferences/netlify/config.json",
    "Library/Application Support/com.vercel.cli/auth.json",
    ".local/share/com.vercel.cli/auth.json",
    ".fly/config.yml",
    ".railway/config.json",
    ".supabase/access-token",
    ".terraform.d/credentials.tfrc.json",
    ".terraformrc",
    ".pulumi/credentials.json",
    ".vault-token",
    ".pgpass",
    ".my.cnf",
    ".mylogin.cnf",
    ".pypirc",
    ".cargo/credentials.toml",
    ".gem/credentials",
    ".local/share/gem/credentials",
    ".m2/settings.xml",
    ".m2/settings-security.xml",
    ".gradle/gradle.properties",
    ".cache/huggingface/token",
    ".cache/huggingface/stored_tokens",
    ".sentryclirc",
    ".config/configstore/firebase-tools.json",
    ".config/op/config",
    ".config/github-copilot/apps.json",
    ".appstoreconnect/private_keys/AuthKey_CANARY.p8",
    ".tauri/idlebiz.key",
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
    ".idlebiz/vault.json",
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
      // what a toolchain reads on every build, beside the logins sandboxed in its folder
      ".yarnrc.yml",
      ".m2/repository/org/a/a.jar",
      ".gradle/caches/modules-2/a.bin",
      ".pulumi/plugins/resource-aws/pulumi-resource-aws",
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

  it("keeps each runner's own login and sandboxes the other's, where a symlink leads too", async () => {
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

  it("lets a runner's runs make the state of a home moved into TMPDIR, as the stand-in's are", async () => {
    // named through TMPDIR's own link (/var to /private/var), as main names the stand-in's homes
    const away = mkdtempSync(path.join(tmpdir(), "idlebiz-stand-in-"));
    try {
      const codex = path.join(away, "codex");
      const claude = path.join(away, "claude");
      mkdirSync(codex);
      mkdirSync(claude);
      const moved = sandbox({
        env: { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex },
        scratch: [tmpdir()],
      });
      const codexState = path.join(codex, "state_5.sqlite");
      const claudeState = path.join(claude, "history.jsonl");
      expect(await tryAs("codex", { writes: [codexState] }, moved)).toEqual({
        [codexState]: "written",
      });
      expect(await tryAs("claude", { writes: [claudeState] }, moved)).toEqual({
        [claudeState]: "written",
      });
    } finally {
      rmSync(away, { force: true, recursive: true });
    }
  });

  it("keeps the founder's own home from the other runner's runs while a runner's is moved, as the stand-in's are", async () => {
    const claudeHome = plant(".claude/canary");
    const claudeAccount = plant(".claude.json");
    const codexLogin = plant(".codex/auth.json");
    const moved = sandbox({
      env: { CLAUDE_CONFIG_DIR: at("stand-in/claude"), CODEX_HOME: at("stand-in/codex") },
    });
    expect(await tryAs("codex", { reads: [claudeHome, claudeAccount] }, moved)).toEqual(
      all([claudeHome, claudeAccount], "EPERM"),
    );
    expect(await tryAs("claude", { reads: [codexLogin], writes: [claudeAccount] }, moved)).toEqual(
      all([codexLogin, claudeAccount], "EPERM"),
    );
  });

  it("keeps the founder's skills from a codex run, which loads every one it can read, one linked in from elsewhere too", async () => {
    const inHome = plant(".codex/skills/review/SKILL.md");
    const system = plant(".codex/skills/.system/imagegen/SKILL.md");
    const shared = plant(".agents/skills/deploy/SKILL.md");
    link(".agents/skills/dots", "dotfiles/skills/dots/");
    plant("dotfiles/skills/dots/SKILL.md");
    const reads = [inHome, system, shared, at(".agents/skills/dots/SKILL.md")];
    expect(await tryAs("codex", { reads })).toEqual(all(reads, "EPERM"));
    expect(await tryAs("claude", { reads: [shared] })).toEqual({ [shared]: "read" });
  });

  it("keeps the founder's instructions and memories from a codex run, which cannot write them either", async () => {
    const personal = [
      plant(".codex/AGENTS.md"),
      plant(".codex/AGENTS.override.md"),
      plant(".codex/memories/memory_summary.md"),
    ];
    const config = plant(".codex/config.toml");
    expect(await tryAs("codex", { reads: [...personal, config] })).toEqual({
      ...all(personal, "EPERM"),
      [config]: "read",
    });
    expect(await tryAs("codex", { writes: personal })).toEqual(all(personal, "EPERM"));
    expect(await tryAs("claude", { reads: personal })).toEqual(all(personal, "EPERM"));
  });

  it("has a codex run find no rules of the founder's, which codex refuses to start on unreadable, nor any linked in from elsewhere", async () => {
    const file = plant(".codex/rules/default.rules");
    const rules = [file, at(".codex/rules")];
    const config = plant(".codex/config.toml");
    expect(await tryAs("codex", { reads: [...rules, config] })).toEqual({
      ...all(rules, "ENOENT"),
      [config]: "read",
    });
    expect(await tryAs("codex", { writes: [file] })).toEqual({ [file]: "ENOENT" });
    expect(await tryAs("claude", { reads: rules })).toEqual(all(rules, "EPERM"));
    rmSync(at(".codex/rules"), { recursive: true });
    const target = link(".codex/rules", "dotfiles/rules/");
    const linked = [plant("dotfiles/rules/default.rules"), at(".codex/rules/default.rules")];
    expect(await tryAs("codex", { reads: [target, ...linked] })).toEqual(
      all([target, ...linked], "ENOENT"),
    );
  });

  it("keeps a run from making `.agents`, where codex finds skills, in its own folders, and leaves it the rest", async () => {
    const [workspace = "", memory = "", cache = ""] = own();
    const skills = [workspace, memory, cache].map((folder) => path.join(folder, ".agents"));
    const nested = path.join(workspace, "src/.agents");
    expect(
      await tryAs("codex", {
        dirs: [...skills, nested],
        symlinks: [[at("tmp"), path.join(workspace, "linked")]],
      }),
    ).toEqual({
      ...all(skills, "EPERM"),
      [nested]: "made",
      [path.join(workspace, "linked")]: "linked",
    });
    expect(
      await tryAs("claude", {
        moves: [[path.join(workspace, "linked"), path.join(workspace, ".agents")]],
        symlinks: [[at("tmp"), path.join(memory, ".agents")]],
      }),
    ).toEqual({
      [path.join(workspace, "linked")]: "EPERM",
      [path.join(memory, ".agents")]: "EPERM",
    });
  });

  it.each(["claude", "codex"] as const)(
    "lets a %s run keep the team's notes in its workspace's AGENTS.md, and fold a CLAUDE.md and an override into it",
    async (runner) => {
      const [workspace = ""] = own();
      const notes = path.join(workspace, "AGENTS.md");
      const claudeMd = path.join(workspace, "CLAUDE.md");
      const override = path.join(workspace, "AGENTS.override.md");
      writeFileSync(claudeMd, "old notes");
      writeFileSync(override, "older notes");
      expect(
        await tryAs(runner, { reads: [claudeMd, override], writes: [notes, claudeMd] }),
      ).toEqual({
        [claudeMd]: "written",
        [notes]: "written",
        [override]: "read",
      });
      expect(await tryAs(runner, { removes: [override] })).toEqual({ [override]: "removed" });
    },
  );

  it.each(["claude", "codex"] as const)(
    "lets a %s run write its runner's state but nothing else in its home, which the founder's own sessions load and run",
    async (runner) => {
      const config =
        runner === "claude"
          ? [
              ".claude/settings.json",
              ".claude/settings.local.json",
              ".claude/settings.json.tmp.1",
              ".claude/.config.json",
              ".claude/backups/.claude.json.backup.1",
              ".claude.json",
              ".claude.json.backup",
              ".claude.json.tmp.1.2",
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
              ".claude/daemon/control.key",
              ".claude/daemon/dispatch/a.json",
              ".claude/jobs/a/job.json",
              ".claude/bridge-spawn/a.json",
              ".claude/seed-admin/a.json",
              // what a setting names by path: a status line, a hook's script
              ".claude/statusline.sh",
              ".claude/scripts/notify.sh",
            ]
          : [
              ".codex/config.toml",
              ".codex/hooks.json",
              ".codex/prompts/a.md",
              ".codex/plugins/a.json",
              ".codex/packages/standalone/bin/codex",
              ".codex/.env",
              ".codex/.env.local",
              ".codex/shell_snapshots/a.sh",
              ".codex/computer-use/Codex Computer Use.app/Contents/MacOS/run",
              ".codex/worktrees/a/app/package.json",
              ".codex/vendor_imports/skills/a/SKILL.md",
              ".codex/keybindings.json",
              ".codex/.codex-global-state.json",
              ".codex/sqlite/codex-dev.db",
              ".codex/.tmp/bundled-marketplaces/a/plugin.json",
              ".codex/process_manager/chat_processes.json",
              ".codex/chrome-native-hosts-v2.json",
              ".codex/browser/config.toml",
              ".codex/node_repl/active_execs",
              ".codex/sessions/a/.codex/config.toml",
              // what `notify` names by path
              ".codex/notify.py",
            ];
      const kept = config.map(plant);
      const state = (
        runner === "claude"
          ? [
              ".claude/todos/a.json",
              ".claude/file-history/a/b",
              ".claude/history.jsonl",
              ".claude/sessions/1.json",
              ".claude/statsig/a",
            ]
          : [
              ".codex/sessions/a.jsonl",
              ".codex/history.jsonl",
              ".codex/memories_1.sqlite",
              ".codex/state_5.sqlite-wal",
              ".codex/auth.json",
              ".codex/log/codex-tui.log",
            ]
      ).map(plant);
      // a name that only starts like the home's, such as the founder's worktrees of real repositories
      const beside = [
        ".claude-worktrees/app/src/index.ts",
        ".claude.d/a.json",
        ".codex-old/config.toml",
      ].map(plant);
      expect(await tryAs(runner, { reads: kept })).toEqual(all(kept, "read"));
      expect(await tryAs(runner, { writes: [...kept, ...beside] })).toEqual(
        all([...kept, ...beside], "EPERM"),
      );
      expect(await tryAs(runner, { writes: state })).toEqual(all(state, "written"));
    },
  );

  it("lets only the sign-in write claude's account file, whose MCP servers start in the founder's sessions", async () => {
    const account = [plant(".claude.json"), at(".claude.json.tmp.1.2")];
    expect(await tryAs("claude", { writes: account })).toEqual(all(account, "EPERM"));
    expect(await tryAs("claude", { writes: account }, sandbox(), signInCommand)).toEqual(
      all(account, "written"),
    );
  });

  it("keeps a runner's instructions where a symlink leads, as a dotfile manager sets them up", async () => {
    const target = link(".claude/CLAUDE.md", "tmp/dots/CLAUDE.md");
    const scratch = plant("tmp/dots/notes.md");
    expect(await tryAs("claude", { writes: [target, scratch] })).toEqual({
      [scratch]: "written",
      [target]: "EPERM",
    });
  });

  it("lets a claude run keep its own folder's transcripts and memory, and no other's", async () => {
    const workspace = realpathSync(at(".idlebiz/company/products/ledger/workspace"));
    const project = at(`.claude/projects/${workspace.replaceAll(/[^a-zA-Z0-9]/gu, "-")}`);
    mkdirSync(at(".claude/projects"), { recursive: true });
    const mine = path.join(project, "memory/MEMORY.md");
    const session = path.join(project, "session.jsonl");
    const theirs = plant(".claude/projects/-Users-me-app/memory/MEMORY.md");
    const transcript = plant(".claude/projects/-Users-me-app/session.jsonl");
    expect(
      await tryAs("claude", {
        dirs: [path.dirname(mine)],
        writes: [mine, session, theirs, transcript],
      }),
    ).toEqual({
      ...all([mine, session], "written"),
      ...all([theirs, transcript], "EPERM"),
      [path.dirname(mine)]: "made",
    });
    // a folder is checked where it goes, never what it carries: none moves in or out
    const other = at(".claude/projects/-Users-me-app");
    const planted = plant("tmp/planted/memory/MEMORY.md");
    expect(
      await tryAs("claude", {
        dirs: [at(".claude/projects/-Users-me-new")],
        moves: [
          [other, at(".claude/projects/aside")],
          [project, at(".claude/projects/-Users-me-other")],
          [path.dirname(path.dirname(planted)), at(".claude/projects/-Users-me-planted")],
          [at(".claude/projects"), at(".claude/projects-old")],
        ],
      }),
    ).toEqual({
      ...all(
        [other, project, path.dirname(path.dirname(planted)), at(".claude/projects")],
        "EPERM",
      ),
      [at(".claude/projects/-Users-me-new")]: "EPERM",
    });
    expect(readFileSync(theirs, "utf-8")).toBe("canary");
  });

  it("keeps the rest of the save from a run, so it forges no approval, verdict or teammate", async () => {
    const workspace = plant(".idlebiz/company/products/ledger/workspace/index.html");
    const memory = plant(".idlebiz/company/agents/ann/memory/notes.md");
    const cache = plant(".idlebiz/cache/npm/_cacache/x");
    const shared = plant(".idlebiz/company/shared/brief.md");
    const forged = [
      plant(".idlebiz/company/approvals.json"),
      plant(".idlebiz/company/bets/more-users/BET.md"),
      plant(".idlebiz/company/agents/ann/AGENTS.md"),
      plant(".idlebiz/company/agents/bob/AGENTS.md"),
      plant(".idlebiz/company/agents/bob/memory/notes.md"),
      plant(".idlebiz/company/tasks/landing/TASK.md"),
      at(".idlebiz/company/tasks/landing/PLAN.md"),
      at(".idlebiz/notes.json"),
    ];
    const linked = at(".idlebiz/company/products/ledger/workspace/approvals.json");
    expect(
      await tryAs("claude", {
        links: [[at(".idlebiz/company/approvals.json"), linked]],
        writes: [workspace, memory, cache, shared, ...forged],
      }),
    ).toEqual({
      ...all(forged, "EPERM"),
      ...all([workspace, memory, cache, shared], "written"),
      [linked]: "EPERM",
    });
    expect(
      await tryAs("claude", { writes: [workspace, memory] }, sandbox({ writable: [] })),
    ).toEqual(all([workspace, memory], "EPERM"));
  });

  it("closes a save that sits in a scratch folder, as a test's does, but for the run's own folders", async () => {
    const save = at("tmp/save");
    const workspace = path.join(save, "company/products/ledger/workspace");
    mkdirSync(workspace, { recursive: true });
    const sandboxed = sandbox({ save, writable: [workspace] });
    const approvals = path.join(save, "company/approvals.json");
    const writes = [approvals, path.join(workspace, "index.html"), at("tmp/other.log")];
    expect(await tryAs("codex", { writes }, sandboxed)).toEqual({
      ...all(writes, "written"),
      [approvals]: "EPERM",
    });
  });

  it.each(["claude", "codex"] as const)(
    "keeps a %s run from writing what the founder's tools run on opening its folder",
    async (runner) => {
      const opened = [
        plant(".idlebiz/company/products/ledger/workspace/.git/config"),
        plant(".idlebiz/company/products/ledger/workspace/.git/hooks/pre-commit.sample"),
        at(".idlebiz/company/products/ledger/workspace/.git/hooks/pre-commit"),
        at(".idlebiz/company/products/ledger/workspace/.git/config.lock"),
        at(".idlebiz/company/products/ledger/workspace/.git/commondir"),
        plant(".idlebiz/company/products/ledger/workspace/.git/info/attributes"),
        plant(".idlebiz/company/products/ledger/workspace/.git/worktrees/w/config.worktree"),
        at(".idlebiz/company/products/ledger/workspace/.git/worktrees/w/commondir"),
        plant(".idlebiz/company/products/ledger/workspace/.git/modules/m/config"),
        plant(".idlebiz/company/products/ledger/workspace/.git/objects/info/alternates"),
        plant(".idlebiz/company/products/ledger/workspace/web/.git/config"),
        at(".idlebiz/company/products/ledger/workspace/.mcp.json"),
        plant(".idlebiz/company/products/ledger/workspace/.claude/settings.json"),
        at(".idlebiz/company/products/ledger/workspace/.claude/settings.local.json"),
        at(".idlebiz/company/agents/ann/memory/.codex"),
        plant(".idlebiz/company/products/ledger/workspace/.vscode/settings.json"),
        at(".idlebiz/company/products/ledger/workspace/.vscode/tasks.json"),
        at(".idlebiz/company/products/ledger/workspace/web/.vscode/launch.json"),
        plant(".idlebiz/company/products/ledger/workspace/.idea/workspace.xml"),
        at(".idlebiz/company/products/ledger/workspace/.envrc"),
      ];
      mkdirSync(at(".idlebiz/company/products/ledger/workspace/web/.vscode"), {
        recursive: true,
      });
      mkdirSync(at(".idlebiz/company/products/ledger/workspace/.git/objects/ab"), {
        recursive: true,
      });
      mkdirSync(at(".idlebiz/company/products/ledger/workspace/.git/logs"), { recursive: true });
      const work = [
        plant(".idlebiz/company/products/ledger/workspace/.git/index"),
        at(".idlebiz/company/products/ledger/workspace/.git/index.lock"),
        at(".idlebiz/company/products/ledger/workspace/.git/COMMIT_EDITMSG"),
        at(".idlebiz/company/products/ledger/workspace/.git/objects/ab/cdef"),
        at(".idlebiz/company/products/ledger/workspace/.git/logs/HEAD"),
        plant(".idlebiz/company/products/ledger/workspace/.git/refs/heads/main"),
        plant(".idlebiz/company/products/ledger/workspace/.claude/notes.md"),
        plant(".idlebiz/company/products/ledger/workspace/src/config"),
        plant(".idlebiz/company/products/ledger/workspace/hooks/use-x.ts"),
        at(".idlebiz/company/products/ledger/workspace/.vscode/extensions.json"),
      ];
      const workspace = at(".idlebiz/company/products/ledger/workspace");
      // nor built anywhere else a run writes, to be moved in whole: a move is checked where it
      // lands, never for what it carries
      const built = [
        at("tmp/built/.mcp.json"),
        at("tmp/built/.claude/settings.json"),
        at("tmp/built/.codex/config.toml"),
        at(".idlebiz/cache/built/.mcp.json"),
      ];
      mkdirSync(at("tmp/built/.claude"), { recursive: true });
      mkdirSync(at("tmp/built/.codex"), { recursive: true });
      plant("tmp/built/dotgit/config");
      mkdirSync(at(".idlebiz/cache/built"), { recursive: true });
      expect(
        await tryAs(runner, {
          dirs: [at("tmp/built/sub/.git"), at(".idlebiz/cache/built/.git")],
          moves: [[at("tmp/built/dotgit"), at("tmp/built/.git")]],
          writes: built,
        }),
      ).toEqual({
        ...all(built, "EPERM"),
        [at("tmp/built/sub/.git")]: "EPERM",
        [at(".idlebiz/cache/built/.git")]: "EPERM",
        [at("tmp/built/dotgit")]: "EPERM",
      });
      expect(
        await tryAs(runner, {
          dirs: [path.join(workspace, ".git/alt")],
          moves: [
            [path.join(workspace, ".git"), path.join(workspace, "git-old")],
            [path.join(workspace, ".claude"), path.join(workspace, "claude-old")],
            [path.join(workspace, ".vscode"), path.join(workspace, "vscode-old")],
            [path.join(workspace, ".idea"), path.join(workspace, "idea-old")],
          ],
          writes: [...opened, ...work],
        }),
      ).toEqual({
        ...all(opened, "EPERM"),
        ...all(work, "written"),
        [path.join(workspace, ".claude")]: "EPERM",
        [path.join(workspace, ".git")]: "EPERM",
        [path.join(workspace, ".git/alt")]: "EPERM",
        [path.join(workspace, ".idea")]: "EPERM",
        [path.join(workspace, ".vscode")]: "EPERM",
      });
    },
  );

  it("reports each deny of a labelled run to whoever watches for its label", async () => {
    const prefix = `sandbox-test-${process.pid}:`;
    const seen: Denial[] = [];
    const stop = watchDenials(prefix, (denial) => {
      seen.push(denial);
    });
    try {
      // the log streams only what lands after it starts
      await sleep(1500);
      const ssh = plant(".ssh/id_ed25519");
      expect(await tryAs("codex", { reads: [ssh] }, sandbox({ label: `${prefix}ann/t1` }))).toEqual(
        {
          [ssh]: "EPERM",
        },
      );
      await vi.waitFor(
        () => {
          expect(seen).toContainEqual({
            label: "ann/t1",
            operation: "file-read-data",
            process: "node",
            target: ssh,
          });
        },
        { interval: 250, timeout: 10_000 },
      );
    } finally {
      stop();
    }
  });

  it("matches those names in any case, as the disk does", async () => {
    const workspace = at(".idlebiz/company/products/ledger/workspace");
    plant(".idlebiz/company/products/ledger/workspace/.git/config");
    mkdirSync(path.join(workspace, ".claude"), { recursive: true });
    const cased = [
      path.join(workspace, ".GIT/config"),
      path.join(workspace, ".Claude/Settings.local.json"),
      path.join(workspace, ".MCP.json"),
      path.join(workspace, ".EnvRC"),
    ];
    expect(await tryAs("claude", { writes: cased })).toEqual(all(cased, "EPERM"));
  });

  it("lets a run commit, branch, merge, rebase, stash and gc in the repository main made, never changing its config", () => {
    const workspace = at(".idlebiz/company/products/ledger/workspace");
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
    // xcrun, which /usr/bin/git runs through, caches in macOS's per-user temp folder whatever
    // TMPDIR says, and a run's sandbox lets it write there
    const darwinTemp = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf-8",
    }).stdout.trim();
    return sandbox({ scratch: [at("tmp"), darwinTemp] }).then((sandboxed) => {
      const run = (script: string) => {
        const [bin, ...args] = sandboxedCommand(sandboxed, "codex", ["/bin/sh", "-c", script]);
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

  it("keeps a run from reading a sibling of vault.json, where the save is named and where it leads", async () => {
    link("linked-save", "elsewhere/idlebiz/");
    const stale = plant("elsewhere/idlebiz/vault.json.tmp");
    const named = at("linked-save/vault.json.tmp");
    const sandboxed = sandbox({
      hostOnly: [at("linked-save/vault.json")],
      save: at("linked-save"),
      writable: [],
    });
    expect(await tryAs("codex", { reads: [named, stale] }, sandboxed)).toEqual(
      all([named, stale], "EPERM"),
    );
  });

  it("keeps a run from changing a folder on PATH that lies in a folder it writes, and where its links lead", async () => {
    const shims = at("tmp/shims/bin");
    const shim = plant("tmp/shims/bin/claude");
    const tool = link(".local/bin/tool", "tmp/tools/bin/tool");
    const later = at("tmp/later/bin");
    const sandboxed = sandbox({ pathDirs: [shims, at(".local/bin"), later, "node_modules/.bin"] });
    const writes = [shim, path.join(shims, "codex"), tool, at("tmp/tools/bin/other")];
    expect(
      await tryAs(
        "claude",
        {
          dirs: [later],
          moves: [[at("tmp/shims"), at("tmp/shims-old")]],
          writes: [...writes, at("tmp/free.log")],
        },
        sandboxed,
      ),
    ).toEqual({
      ...all(writes, "EPERM"),
      [at("tmp/free.log")]: "written",
      [at("tmp/shims")]: "EPERM",
      [later]: "EPERM",
    });
    const { runsAsFounder } = await sandboxed;
    expect(runsAsFounder.map(({ path: kept }) => kept)).toEqual(
      expect.arrayContaining([shims, at("tmp/tools/bin"), later]),
    );
    expect(runsAsFounder.map(({ path: kept }) => kept)).not.toContain(at(".local/bin"));
  });

  it("keeps a run from a terminal's shims in TMPDIR, which main's PATH does not name", async () => {
    const shim = plant("tmp/cmux-cli-shims/panel/claude");
    const panel = at("tmp/cmux-cli-shims/other");
    const sandboxed = sandbox({ shims: [at("tmp/cmux-cli-shims")] });
    expect(
      await tryAs(
        "claude",
        {
          dirs: [panel],
          moves: [[at("tmp/cmux-cli-shims"), at("tmp/shims-old")]],
          writes: [shim, at("tmp/free.log")],
        },
        sandboxed,
      ),
    ).toEqual({
      [at("tmp/cmux-cli-shims")]: "EPERM",
      [at("tmp/free.log")]: "written",
      [panel]: "EPERM",
      [shim]: "EPERM",
    });
    expect(readFileSync(shim, "utf-8")).toBe("canary");
  });

  it("keeps a run from swapping a folder of its own for a link, so the next run's sandbox holds too", async () => {
    const approvals = plant(".idlebiz/company/approvals.json");
    const memory = at(".idlebiz/company/agents/ann/memory");
    const cache = at(".idlebiz/cache");
    plant(".idlebiz/cache/npm/x");
    const swap = at(".idlebiz/company/products/ledger/workspace/swap");
    mkdirSync(swap);
    const first = sandbox();
    expect(await tryAs("codex", { removes: [memory, cache] }, first)).toEqual(
      all([memory, cache], "EPERM"),
    );
    expect(existsSync(at(".idlebiz/cache/npm"))).toBe(false);
    expect(
      await tryAs(
        "codex",
        {
          moves: [
            [memory, at(".idlebiz/company/products/ledger/workspace/memory")],
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
    const through = path.join(inMemory, "company/approvals.json");
    expect(await tryAs("codex", { writes: [approvals, through] }, sandbox())).toEqual(
      all([approvals, through], "EPERM"),
    );
  });

  it("starts no run whose folder is a link or lies outside the save", async () => {
    await expect(sandbox()).resolves.toBeDefined();
    const ann = at(".idlebiz/company/agents/ann");
    const memory = path.join(ann, "memory");
    rmSync(memory, { recursive: true });
    symlinkSync(at(".idlebiz"), memory);
    await expect(sandbox()).rejects.toMatchObject({
      refusal: { folder: memory, kind: "linked", link: memory },
    });
    rmSync(ann, { recursive: true });
    mkdirSync(at("elsewhere/ann"), { recursive: true });
    symlinkSync(at("elsewhere/ann"), ann);
    await expect(sandbox()).rejects.toMatchObject({ refusal: { kind: "linked", link: ann } });
    for (const folder of [at("projects/app"), at(".idlebiz")]) {
      await expect(sandbox({ writable: [folder] })).rejects.toThrow(
        new FolderRefusedError({ folder, kind: "outside-save" }),
      );
    }
  });

  it("keeps a run from starting an app through LaunchServices, which would run it unsandboxed", async () => {
    const app = at("tmp/Canary.app");
    const launched = at("tmp/launched");
    mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
    writeFileSync(
      path.join(app, "Contents/Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>canary</string>
<key>CFBundleIdentifier</key><string>io.idlebiz.sandbox-canary.${process.pid}.${Date.now()}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
    );
    writeFileSync(path.join(app, "Contents/MacOS/canary"), `#!/bin/sh\ntouch '${launched}'\n`, {
      mode: 0o755,
    });
    const sandboxed = await sandbox();
    const argv = ["/usr/bin/open", "-g", "-n", app];
    expect(exitOf(sandboxedCommand(sandboxed, "claude", argv))).not.toBe(0);
    await sleep(1500);
    expect(existsSync(launched)).toBe(false);
    // the control: the same open from a sign-in, which may open the browser, does start it
    expect(exitOf(signInCommand(sandboxed, "claude", argv))).toBe(0);
    // LaunchServices registers a bundle it has never seen before it starts it, which a cold runner can take seconds over
    for (let waited = 0; waited < 200 && !existsSync(launched); waited += 1) {
      await sleep(100);
    }
    expect(existsSync(launched)).toBe(true);
  });

  it("lets a run list processes, as version managers do to find their shell", async () => {
    const sandboxed = await sandbox();
    for (const runner of ["claude", "codex"] as const) {
      expect(
        exitOf(sandboxedCommand(sandboxed, runner, ["/bin/ps", "-p", "1", "-o", "pid="])),
      ).toBe(0);
    }
  });

  it("keeps a run from the CLIs that drive other apps, which a sign-in may still run", async () => {
    const sandboxed = await sandbox();
    const script = ["/usr/bin/osascript", "-e", "return 1"];
    expect(exitOf(sandboxedCommand(sandboxed, "codex", script))).not.toBe(0);
    expect(exitOf(signInCommand(sandboxed, "codex", script))).toBe(0);
  });

  it("stops git's Keychain helper for every run", async () => {
    const helper = plant("bin/git-credential-osxkeychain");
    spawnSync("chmod", ["+x", helper]);
    for (const runner of ["claude", "codex"] as const) {
      expect(await tryAs(runner, { runs: [helper] })).toEqual({ [helper]: "EPERM" });
    }
  });

  it.skipIf(!pasteboardAnswers)(
    "keeps a run from the pasteboard, where a key the founder pastes sits, which a sign-in may still read",
    async () => {
      const sandboxed = await sandbox();
      const held = outputOf(PASTE);
      const canary = `idlebiz-sandbox-canary-${process.pid}-${Date.now()}`;
      outputOf(COPY, canary);
      try {
        for (const runner of ["claude", "codex"] as const) {
          expect(startsUnder(sandboxed, runner)).toBe(true);
          expect(outputOf(sandboxedCommand(sandboxed, runner, PASTE))).not.toContain(canary);
          // nor does it put its own in place of what the founder copied
          outputOf(sandboxedCommand(sandboxed, runner, COPY), "planted");
        }
        expect(outputOf(PASTE)).toBe(canary);
        // the control: the same read from a sign-in does reach it
        expect(outputOf(signInCommand(sandboxed, "claude", PASTE))).toBe(canary);
      } finally {
        outputOf(COPY, held);
      }
    },
  );

  // launchd refuses a job from any sandboxed caller, a sign-in's too, so the control is unsandboxed:
  // it shows this session starts jobs at all, without which the canary proves nothing
  it("keeps a run from having launchd start a job, which runs unsandboxed", async ({ skip }) => {
    const sandboxed = await sandbox();
    const label = `io.idlebiz.sandbox-canary.${process.pid}.${Date.now()}`;
    const control = at("tmp/control");
    const submitted = at("tmp/submitted");
    const bootstrapped = at("tmp/bootstrapped");
    const plist = at("tmp/canary.plist");
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}.boot</string>
<key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>${bootstrapped}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`,
    );
    const domain = `gui/${userInfo().uid}`;
    const submit = ["/bin/launchctl", "submit", "-l", label, "--", "/usr/bin/touch", submitted];
    try {
      spawnSync("/bin/launchctl", [
        "submit",
        "-l",
        `${label}.control`,
        "--",
        "/usr/bin/touch",
        control,
      ]);
      for (let waited = 0; waited < 200 && !existsSync(control); waited += 1) {
        await sleep(100);
      }
      if (!existsSync(control)) {
        skip();
      }
      expect(startsUnder(sandboxed, "claude")).toBe(true);
      expect(startsUnder(sandboxed, "codex")).toBe(true);
      outputOf(sandboxedCommand(sandboxed, "claude", submit));
      outputOf(
        sandboxedCommand(sandboxed, "codex", ["/bin/launchctl", "bootstrap", domain, plist]),
      );
      await sleep(1500);
      expect(existsSync(submitted)).toBe(false);
      expect(existsSync(bootstrapped)).toBe(false);
    } finally {
      spawnSync("/bin/launchctl", ["remove", `${label}.control`]);
      spawnSync("/bin/launchctl", ["remove", label]);
      spawnSync("/bin/launchctl", ["bootout", `${domain}/${label}.boot`]);
    }
  });

  // launchd hands what `launchctl setenv` sets to every app opened after it: IdleBiz's own shell,
  // the founder's terminal. No rule of the sandbox's names a setenv, so this measures what launchd does
  // with one from a sandboxed caller. The control is unsandboxed: it shows this session's launchd takes a
  // setenv at all, without which the canary proves nothing. Unset either way, since the steps after
  // this suite share the domain.
  it("keeps a run from setting the env launchd hands the apps opened after it", async ({
    skip,
  }) => {
    const sandboxed = await sandbox();
    const name = `SANDBOX_CANARY_${process.pid}_${Date.now()}`;
    const canary = (verb: string, ...value: string[]): string =>
      outputOf(["/bin/launchctl", verb, name, ...value]).trim();
    try {
      canary("setenv", "control");
      if (canary("getenv") !== "control") {
        skip();
      }
      canary("unsetenv");
      for (const runner of ["claude", "codex"] as const) {
        expect(startsUnder(sandboxed, runner)).toBe(true);
        outputOf(sandboxedCommand(sandboxed, runner, ["/bin/launchctl", "setenv", name, runner]));
        expect(canary("getenv")).toBe("");
      }
    } finally {
      canary("unsetenv");
    }
  });

  it("keeps a run from mounting devfs, whose files carry no provenance for LaunchServices to check", async ({
    skip,
  }) => {
    const sandboxed = await sandbox();
    const mountpoint = realpathSync(mkdtempSync(path.join(tmpdir(), "idlebiz-mount-")));
    const mount = ["/sbin/mount", "-t", "devfs", "-o", "noowners", "devfs", mountpoint];
    try {
      for (const runner of ["claude", "codex"] as const) {
        expect(startsUnder(sandboxed, runner)).toBe(true);
        outputOf(sandboxedCommand(sandboxed, runner, mount));
        expect(existsSync(path.join(mountpoint, "null"))).toBe(false);
      }
      // the control: the same mount from a sign-in, whose sandbox denies no file-mount, does land; a
      // session whose user mounts no devfs skips, since there the canary proves nothing
      outputOf(signInCommand(sandboxed, "claude", mount));
      if (!existsSync(path.join(mountpoint, "null"))) {
        skip();
      }
    } finally {
      spawnSync("/sbin/umount", [mountpoint]);
      // never recursive: through a mount the sandbox missed it would remove device nodes; and a
      // folder still mounted over is left, never thrown over the failure that explains it
      spawnSync("/bin/rmdir", [mountpoint]);
    }
  });

  it("keeps a run from laying an image it made over a folder the founder runs programs from", async ({
    skip,
  }) => {
    const sandboxed = await sandbox();
    const bin = at(".local/bin");
    mkdirSync(bin, { recursive: true });
    plant("image/claude");
    const image = at("tmp/canary.dmg");
    spawnSync("/usr/bin/hdiutil", ["create", "-quiet", "-srcfolder", at("image"), image]);
    expect(existsSync(image)).toBe(true);
    const attached: string[] = [];
    try {
      const attach = ["/usr/bin/hdiutil", "attach", "-nobrowse", "-mountpoint", bin, image];
      for (const runner of ["claude", "codex"] as const) {
        expect(startsUnder(sandboxed, runner)).toBe(true);
        // diskarbitrationd mounts it, and checks its caller's sandbox for a folder the caller names
        attached.push(...disksIn(outputOf(sandboxedCommand(sandboxed, runner, attach))));
        expect(existsSync(path.join(bin, "claude"))).toBe(false);
      }
      // the control is unsandboxed, whatever diskarbitrationd makes of a sandboxed caller: it shows
      // this session lays an image over a folder at all, without which the canary proves nothing
      attached.push(...disksIn(outputOf(attach)));
      if (!existsSync(path.join(bin, "claude"))) {
        skip();
      }
    } finally {
      for (const disk of new Set([bin, ...attached])) {
        spawnSync("/usr/bin/hdiutil", ["detach", "-force", disk]);
      }
    }
    // each attach takes diskarbitrationd seconds, refused or not, and the control mounts and detaches
  }, 90_000);

  it("keeps a run from having cfprefsd write a preference, as a sign-in still could", async () => {
    const sandboxed = await sandbox();
    const domain = `io.idlebiz.sandbox-canary.${process.pid}.${Date.now()}`;
    const write = ["/usr/bin/defaults", "write", domain, "canary", "-string", "landed"];
    const read = () => outputOf(["/usr/bin/defaults", "read", domain, "canary"]).trim();
    try {
      for (const runner of ["claude", "codex"] as const) {
        expect(startsUnder(sandboxed, runner)).toBe(true);
        outputOf(sandboxedCommand(sandboxed, runner, write));
      }
      expect(read()).toBe("");
      // the control: cfprefsd writes for a caller allowed this or the plist's own write, and a
      // sign-in is denied only the second
      outputOf(signInCommand(sandboxed, "claude", write));
      expect(read()).toBe("landed");
    } finally {
      spawnSync("/usr/bin/defaults", ["delete", domain]);
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
      more: Partial<Parameters<typeof sandboxFor>[0]> = {},
      moves: readonly [string, string][] = [],
    ) => {
      const sandboxed = await sandboxFor({
        clis: [],
        closedPorts: [],
        env: {},
        home: short,
        hostOnly: [],
        pathDirs: [],
        save: path.join(short, ".idlebiz"),
        scratch: [short, launchd],
        shims: [],
        sshAgent: null,
        writable: [],
        ...more,
      });
      const argv = sandboxedCommand(sandboxed, runner, [
        process.execPath,
        "-e",
        CONNECT,
        JSON.stringify([targets, moves]),
      ]);
      const [bin, ...args] = argv;
      return Outcomes.parse(parseJson(spawnSync(bin, args, { encoding: "utf-8" }).stdout));
    };

    it("answers only in the run's own folders and the agent-browser namespace of its runner and folders", async () => {
      const save = path.join(short, ".idlebiz");
      const workspace = path.join(save, "company/products/ledger/workspace");
      const namespaces = path.join(short, ".agent-browser/namespaces");
      const daemon = (runner: "claude" | "codex", folders: readonly string[]) =>
        `.agent-browser/namespaces/${browserNamespace(save, runner, folders)}/run/d.sock`;
      const [inWorkspace, claude, codex, otherFolders, ...founders] = await Promise.all(
        [
          ".idlebiz/company/products/ledger/workspace/tmp/tsx-501/1.pipe",
          daemon("claude", [workspace]),
          daemon("codex", []),
          daemon("claude", []),
          ".agent-browser/default.sock",
          ".ssh/agent.sock",
          "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
          ".orbstack/run/docker.sock",
          ".codex/ipc/ipc.sock",
          ".codex/tmp/run.sock",
          "work/com.google.Chrome.ab12/SingletonSocket",
          "work/discord-ipc-0",
        ].map((name) => listen(path.join(short, name))),
      );
      expect(path.dirname(path.dirname(claude ?? ""))).toBe(
        path.join(namespaces, browserNamespace(save, "claude", [workspace])),
      );
      const blocked = [...founders, codex ?? "", otherFolders ?? ""];
      expect(
        await connect("claude", [inWorkspace ?? "", claude ?? "", ...blocked], {
          writable: [workspace],
        }),
      ).toEqual({
        ...all(blocked, "EPERM"),
        [inWorkspace ?? ""]: "reached",
        [claude ?? ""]: "reached",
      });
      expect(await connect("codex", [claude ?? "", codex ?? ""])).toEqual({
        [claude ?? ""]: "EPERM",
        [codex ?? ""]: "reached",
      });
    });

    it("reaches its own line to the company and no other run's, though both sit in the save", async () => {
      const save = path.join(short, ".idlebiz");
      const [mine, theirs] = await Promise.all(
        [".idlebiz/.run/aaaaaaaaaaaa", ".idlebiz/.run/bbbbbbbbbbbb"].map((name) =>
          listen(path.join(short, name)),
        ),
      );
      const workspace = path.join(save, "company/products/ledger/workspace");
      mkdirSync(workspace, { recursive: true });
      for (const runner of ["claude", "codex"] as const) {
        expect(
          await connect(runner, [mine ?? "", theirs ?? ""], {
            apiSocket: mine ?? "",
            writable: [workspace],
          }),
        ).toEqual({ [mine ?? ""]: "reached", [theirs ?? ""]: "EPERM" });
      }
      // nor can it take the other's place
      expect(
        await connect("claude", [mine ?? ""], { apiSocket: mine ?? "", writable: [workspace] }, [
          [theirs ?? "", path.join(save, ".run/moved")],
        ]),
      ).toEqual({ [mine ?? ""]: "reached", [theirs ?? ""]: "EPERM" });
    });

    it("keeps an ssh-agent started from a terminal, wherever its TMPDIR is, in the folder it named", async () => {
      const agent = await listen(path.join(short, "ssh-AbC123/agent.4242"));
      const folder = path.dirname(agent);
      mkdirSync(path.join(short, "work"));
      expect(await connect("codex", [agent], {}, [[folder, path.join(short, "work/ssh")]])).toEqual(
        { [agent]: "EPERM", [folder]: "EPERM" },
      );
    });

    it("keeps where main's env names it, and launchd's, where they are", async () => {
      const agent = await listen(path.join(short, "agent/ssh.sock"));
      const listeners = await listen(path.join(launchd, "Listeners"));
      const away = path.join(short, "work/moved.sock");
      mkdirSync(path.dirname(away));
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
      expect(await connect("codex", targets, { closedPorts: [port] })).toEqual(
        all(targets, "EPERM"),
      );
      expect(await connect("codex", targets.slice(0, 2))).toEqual(
        all(targets.slice(0, 2), "reached"),
      );
    });
  });

  it("passes the boot check, and fails it when the canary is readable, a stray write lands or the profile breaks", async () => {
    const sandboxed = await sandbox();
    expect(await checkSandbox(sandboxed)).toEqual({ kind: "holds" });
    expect(await checkSandbox(sandboxed, under("(version 1)\n(allow default)"))).toEqual({
      kind: "read-unreadable",
    });
    expect(
      await checkSandbox(
        sandboxed,
        under('(version 1)\n(allow default)\n(deny file-read* (regex #"/vault\\.json$"))'),
      ),
    ).toEqual({ kind: "wrote-outside" });
    expect(await checkSandbox(sandboxed, under("(version 1)\n(allow nonsense)"))).toMatchObject({
      kind: "failed",
    });
  });
});
