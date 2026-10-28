import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readdir, readlink, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runnerBin } from "@repo/agent-driver/detect";
import { DEV_PORT } from "@repo/contract/routes";
import { RUNNER_IDS } from "@repo/domain/runners";
import type { RunnerId } from "@repo/domain/runners";
import { pagePorts } from "../page-server";
import { rootDir } from "../paths";
import { RefusalError } from "../refusal";
import { secretsPath } from "../secrets";
import { inside } from "./seal";
import type { Reach, RunnerHome, Seal } from "./seal";

/** The founder's logins under HOME, which no run reads or writes. */
const LOGINS = [
  ".ssh",
  ".config/gh",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".config/git/credentials",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".gnupg",
  ".config/gcloud",
  ".config/stripe",
  ".wrangler",
  ".config/.wrangler",
  "Library/Preferences/.wrangler",
  ".config/cloudflare",
  "Library/Preferences/cloudflare",
  ".config/netlify",
  "Library/Preferences/netlify",
  "Library/Application Support/com.vercel.cli",
  ".local/share/com.vercel.cli",
  ".fly",
  ".railway",
  ".supabase",
  ".terraform.d",
  ".pypirc",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".config/configstore",
  ".config/op",
  ".config/github-copilot",
  ".appstoreconnect",
  ".agent-browser/auth",
  ".agent-browser/.encryption-key",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Arc",
  "Library/Application Support/Firefox",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Slack",
  "Library/Containers/com.tinyspeck.slackmacgap",
  "Library/Application Support/discord",
  "Library/Cookies",
];

/**
 * Each runner's home, and what of it the seal treats apart from the rest, which no run writes; why
 * each is sealed so is docs/seal.md's "A run's seal". `state` is what its runs write, each a
 * prefix, since a CLI writes a file through a sibling it renames over it; one ending in a slash is
 * only that folder. claude's `projects/` is written only for the run's own folder
 * (`Seal.claudeProjects`). `account` is where the CLI records the founder's account, in the home
 * and beside it in HOME, each with every name that starts with it, which only the sign-in writes.
 * `personal` is what of the founder's own its runs cannot read, in the home and in HOME, and
 * `absent` what they read as missing.
 */
const RUNNER_HOMES = {
  claude: {
    absent: [],
    // its MCP servers, user-wide and per project, start in the founder's own sessions, unsealed
    account: [".claude.json"],
    dir: ".claude",
    override: "CLAUDE_CONFIG_DIR",
    personal: { home: [], user: [] },
    state: [
      "sessions/",
      "todos/",
      "tasks/",
      "plans/",
      "file-history/",
      "history.jsonl",
      "statsig/",
      "telemetry/",
      "debug/",
      "cache/",
      "paste-cache/",
      "image-cache/",
      "state/",
      ".cc-writes/",
      "stats-cache.json",
      "mcp-needs-auth-cache.json",
      ".last-cleanup",
    ],
  },
  codex: {
    absent: ["rules"],
    account: [],
    dir: ".codex",
    override: "CODEX_HOME",
    // its own skills are installed in `skills/.system`, and go with the rest
    personal: {
      home: ["skills", "AGENTS.md", "AGENTS.override.md", "memories"],
      user: [".agents/skills"],
    },
    state: [
      "sessions/",
      "archived_sessions/",
      "log/",
      "cache/",
      "generated_images/",
      "thread-writer-locks/",
      "rollout-migrations/",
      "history.jsonl",
      "session_index.jsonl",
      // refreshed as a run signs in
      "auth.json",
      "installation_id",
      "version.json",
      "models_cache.json",
      "internal_storage.json",
      ".sandbox_migration",
      ".personality_migration",
      // its databases, each with its -wal and -shm
      "state_",
      "logs_",
      "queue_",
      "goals_",
      "memories_",
      "thread_history_",
    ],
  },
} as const satisfies Record<
  RunnerId,
  {
    absent: readonly string[];
    account: readonly string[];
    dir: string;
    override: string;
    personal: { home: readonly string[]; user: readonly string[] };
    state: readonly string[];
  }
>;

/**
 * Sockets in the scratch folders of what acts as the founder, which a run could otherwise remove
 * and listen in place of: podman's machine sockets in TMPDIR, claude's sessions, which take
 * messages from each other, the codex app's browser tool, which drives the founder's Chrome, and
 * OpenAI's computer-use service.
 */
const SCRATCH_SOCKETS = [
  path.join(tmpdir(), "podman"),
  "/private/tmp/cc-socks",
  "/private/tmp/codex-browser-use",
  "/private/tmp/com.openai.sky.CUAService",
];

/**
 * Where a terminal keeps, in the founder's TMPDIR, the shims it puts first on its own PATH: cmux's
 * `claude` and `codex` wrappers, one folder per panel. Main's PATH names none of them.
 */
const TERMINAL_SHIMS = ["cmux-cli-shims"];

// Chrome's DevTools port (a browser the founder debugs, signed in as them), node's inspector, and
// Vite's dev server, which reads any file of the checkout to whoever asks (`/@fs`) and under
// `pnpm dev:browser` signs a browser in to main's page: each answers anyone on loopback as the
// founder. Main's own page port, which carries the founder's approve button, is closed beside them
// (`pagePorts`).
const CLOSED_PORTS = [9222, 9229, DEV_PORT];

/** The path Seatbelt sees for `file`: the real path of the deepest part that exists, the rest after it. */
export const realPathOf = async (file: string): Promise<string> => {
  try {
    return await realpath(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(await realPathOf(parent), path.basename(file));
  }
};

/** `named`, and where it leads when a symlink on its way points somewhere else. */
const reachOf = async (named: string, match: Reach["match"] = "subpath"): Promise<Reach[]> => {
  const resolved = await realPathOf(named);
  return [named, ...(resolved === named ? [] : [resolved])].map((at): Reach => ({
    match,
    path: at,
  }));
};

const reachesOf = async (
  paths: readonly string[],
  match: Reach["match"] = "subpath",
): Promise<Reach[]> => {
  const reaches = await Promise.all(paths.map((at) => reachOf(at, match)));
  return reaches.flat();
};

/** Whether `file` is there and can be run. */
const runnable = async (file: string): Promise<boolean> => {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * What spawning `command` with `pathDirs` as PATH may run: itself when it names a path, else
 * every copy on PATH, not just the first, since a shim found first can run the next one.
 */
const foundOn = async (command: string, pathDirs: readonly string[]): Promise<string[]> => {
  if (command.includes(path.sep)) {
    return [path.resolve(command)];
  }
  const files = pathDirs.map((dir) => path.join(dir, command));
  const runs = await Promise.all(files.map(runnable));
  return files.filter((_file, at) => runs[at] === true);
};

// as the kernel gives up on a chain of symlinks
const MAX_LINKS = 32;

/** `file`, then each path its symlinks lead through, as each link names it. */
const linkChain = async (file: string): Promise<string[]> => {
  const chain = [file];
  let at = file;
  while (chain.length <= MAX_LINKS) {
    const target = await readlink(at).catch(() => null);
    if (target === null) {
      break;
    }
    at = path.resolve(path.dirname(at), target);
    chain.push(at);
  }
  return chain;
};

/** Every symlink in `folders`: a program on PATH, wherever it leads. */
const linksIn = async (folders: readonly string[]): Promise<string[]> => {
  const links = await Promise.all(
    folders.map(async (folder) => {
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      return entries
        .filter((entry) => entry.isSymbolicLink())
        .map((entry) => path.join(folder, entry.name));
    }),
  );
  return links.flat();
};

/**
 * Where each symlink in a runner's home, or in a folder there, leads: a dotfile manager links the
 * founder's settings, instructions and skills in from elsewhere, maybe a folder a run writes.
 */
const homeLinkTargets = async (home: string): Promise<string[]> => {
  const entries = await readdir(home, { withFileTypes: true }).catch(() => []);
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(home, entry.name));
  const links = await linksIn([home, ...folders]);
  const chains = await Promise.all(links.map(linkChain));
  return chains.flatMap((chain) => chain.slice(1));
};

/**
 * The run's own `folders`, each where the save resolves. Each must sit in the save with no
 * symlink from the save down to it: the seal allows the path it names, never where a link a run
 * could have left there leads.
 */
const ownFolders = async (save: string, folders: readonly string[]): Promise<Reach[]> => {
  const realSave = await realPathOf(save);
  return await Promise.all(
    folders.map(async (folder): Promise<Reach> => {
      const inSave = path.relative(save, folder);
      const parts = inSave.split(path.sep);
      if (inSave === "" || path.isAbsolute(inSave) || parts[0] === "..") {
        throw new RefusalError(
          `${folder} is no folder inside the save, so IdleBiz starts no run that writes it.`,
        );
      }
      for (let depth = 1; depth <= parts.length; depth += 1) {
        const at = path.join(save, ...parts.slice(0, depth));
        const stats = await lstat(at).catch(() => null);
        if (stats?.isSymbolicLink() === true) {
          throw new RefusalError(
            `IdleBiz starts no run that writes ${folder} while ${at} is a symlink, which would let it write where the link leads. Remove the link to go on.`,
          );
        }
      }
      return { match: "subpath", path: path.join(realSave, inSave) };
    }),
  );
};

/**
 * A runner's home, and the state in it its runs write, each where it is named and where it leads:
 * a dotfile manager may link any of it in from elsewhere. Moved by `override`, the account file
 * sits only in it, else beside it in HOME too.
 */
const runnerHomeOf = async (
  home: string,
  runner: RunnerId,
  env: Readonly<Record<string, string | undefined>>,
): Promise<RunnerHome> => {
  const { absent, account, dir, override, personal, state } = RUNNER_HOMES[runner];
  const moved = env[override];
  const inHome = moved === undefined || moved === "";
  const folder = inHome ? path.join(home, dir) : path.resolve(moved);
  const states = await Promise.all(
    state.map((name) =>
      name.endsWith("/")
        ? reachOf(path.join(folder, name.slice(0, -1)))
        : reachOf(path.join(folder, name), "prefix"),
    ),
  );
  const accounts = account.flatMap((name) => [
    path.join(folder, name),
    ...(inHome ? [path.join(home, name)] : []),
  ]);
  return {
    absent: await reachesOf(absent.map((name) => path.join(folder, name))),
    account: await reachesOf(accounts, "prefix"),
    folder: await realPathOf(folder),
    home: await reachOf(folder),
    personal: await reachesOf([
      ...personal.home.map((name) => path.join(folder, name)),
      ...personal.user.map((name) => path.join(home, name)),
    ]),
    state: states.flat(),
  };
};

/** Where claude keeps `cwd`'s transcripts and memory. */
const claudeProjectOf = (claudeHome: string, cwd: string): string =>
  path.join(claudeHome, "projects", cwd.replaceAll(/[^a-zA-Z0-9]/gu, "-"));

const execFileAsync = promisify(execFile);

/** macOS's per-user cache folder (DARWIN_USER_CACHE_DIR), where its own libraries write. */
const darwinUserCacheDir = async (): Promise<string> => {
  const { stdout } = await execFileAsync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"]);
  return path.resolve(stdout.trim());
};

/**
 * The agent-browser namespace a `runner`'s runs on `save` that write `folders` start their
 * daemons in, apart from the founder's own, the other runner's and those of runs with other
 * folders: a daemon reads and writes what the run that started it could, from that run's
 * working directory, however long it outlives the run. Short: the daemon's socket path under it
 * must fit in 103 bytes.
 */
export const browserNamespace = (
  save: string,
  runner: RunnerId,
  folders: readonly string[],
): string =>
  `idlebiz-${createHash("sha256")
    .update([save, runner, ...folders].join("\0"))
    .digest("hex")
    .slice(0, 8)}`;

/** The agent-browser namespace `runner`'s runs under `seal` start their daemons in. */
export const namespaceUnder = (seal: Seal, runner: RunnerId): string =>
  path.basename(seal.namespaces[runner].path);

/** Where agent-browser keeps its daemons' sockets for a run, whatever the founder's env says. */
export const browserSocketDir = (): string => path.join(homedir(), ".agent-browser");

/** The seal of a run under `home`, resolved as it stands on disk now. */
export const sealFor = async ({
  apiSocket = null,
  clis,
  closedPorts,
  env,
  home,
  mainOnly,
  pathDirs,
  save,
  scratch,
  shims,
  sshAgent,
  writable,
}: {
  home: string;
  /** Where every run writes besides its own folders. */
  scratch: readonly string[];
  /** Folders a terminal runs the founder's programs from that main's PATH need not name. */
  shims: readonly string[];
  /** Loopback ports whose listener would take orders from anyone, as the founder. */
  closedPorts: readonly number[];
  /** Main's env, where a runner's home may have been moved. */
  env: Readonly<Record<string, string | undefined>>;
  /** What only main touches, with every name that starts with it: main writes a file through `<file>.tmp`. */
  mainOnly: readonly string[];
  /** The founder's ssh agent, when main's env names one. */
  sshAgent: string | null;
  /** The save, where a run writes only its own folders. */
  save: string;
  /** Main's PATH, the login shell's folders and the installer's on it whether they exist yet or not. */
  pathDirs: readonly string[];
  /** The runner CLIs as main names them, a command on PATH or a path, which the founder runs unsealed. */
  clis: readonly string[];
  /** The run's own folders, each in the save, its working directory first. */
  writable: readonly string[];
  /** The socket main answers this run's company tools on, when it is a run's seal. */
  apiSocket?: string | null;
}): Promise<Seal> => {
  const realHome = await realPathOf(home);
  const under = (names: readonly string[]): Promise<Reach[]> =>
    reachesOf(names.map((name) => path.join(realHome, name)));
  const [claude, codex] = await Promise.all([
    runnerHomeOf(realHome, "claude", env),
    runnerHomeOf(realHome, "codex", env),
  ]);
  const homes = { claude, codex };
  const scratchReaches = await reachesOf([...new Set(scratch)]);
  const own = await ownFolders(save, writable);
  const [cwd] = own;
  const folders = own.map(({ path: at }) => at);
  const namespaceOf = (runner: RunnerId): Reach => ({
    match: "subpath",
    path: path.join(
      realHome,
      ".agent-browser",
      "namespaces",
      browserNamespace(save, runner, folders),
    ),
  });
  const namespaces = { claude: namespaceOf("claude"), codex: namespaceOf("codex") };
  const roots = [
    ...scratchReaches,
    ...claude.state,
    ...codex.state,
    ...Object.values(namespaces),
    ...own,
  ];
  // a relative folder names no fixed place to seal
  const onPathDirs = [...new Set(pathDirs.filter((dir) => path.isAbsolute(dir)))];
  const found = await Promise.all(clis.map((cli) => foundOn(cli, onPathDirs)));
  const runs = [...new Set([...found.flat(), ...(await linksIn(onPathDirs))])];
  const chains = await Promise.all(runs.map(linkChain));
  const programs = chains.flat().map((at) => path.dirname(at));
  const linked = await Promise.all([claude.folder, codex.folder].map(homeLinkTargets));
  const candidates = await reachesOf([
    ...new Set([...onPathDirs, ...programs, ...shims, ...linked.flat()]),
  ]);
  const inRoot = ({ path: at }: Reach): boolean =>
    roots.some((root) =>
      root.match === "prefix" ? at.startsWith(root.path) : inside(root.path, at),
    );
  return {
    apiSocket: apiSocket === null ? [] : await reachOf(apiSocket),
    claudeProjects: {
      own: cwd === undefined ? null : claudeProjectOf(claude.folder, cwd.path),
      projects: path.join(claude.folder, "projects"),
    },
    closedPorts,
    namespaces,
    preferences: path.join(realHome, "Library", "Preferences"),
    runners: homes,
    runsAsFounder: candidates.filter(inRoot),
    save: await reachOf(save),
    scratch: scratchReaches,
    skillFolders: await reachesOf(folders.map((folder) => path.join(folder, ".agents"))),
    sockets: [
      ...(await reachesOf(SCRATCH_SOCKETS)),
      ...(sshAgent === null ? [] : await reachOf(sshAgent)),
    ],
    unreadable: [...(await under(LOGINS)), ...(await reachesOf(mainOnly, "prefix"))],
    writable: own,
  };
};

/**
 * The seal of a run that writes `writable` and calls the company on `apiSocket`, resolved as this
 * machine stands now: its home, main's PATH and the CLIs on it. Each run resolves its own: a login that turns into a symlink after
 * boot is sealed where it leads from the next run on.
 */
export const machineSeal = async (
  writable: readonly string[],
  apiSocket: string | null = null,
): Promise<Seal> => {
  const agent = process.env.SSH_AUTH_SOCK;
  const cache = await darwinUserCacheDir();
  // macOS's own libraries write its per-user temp folder whatever TMPDIR says
  const temps = [tmpdir(), path.join(path.dirname(cache), "T")];
  return await sealFor({
    apiSocket,
    clis: RUNNER_IDS.map(runnerBin),
    closedPorts: [...CLOSED_PORTS, ...pagePorts()],
    env: process.env,
    home: homedir(),
    mainOnly: [secretsPath()],
    pathDirs: (process.env.PATH ?? "").split(path.delimiter),
    save: rootDir(),
    scratch: [...temps, cache, "/private/tmp"],
    shims: temps.flatMap((temp) => TERMINAL_SHIMS.map((name) => path.join(temp, name))),
    sshAgent: agent === undefined || agent === "" ? null : agent,
    writable,
  });
};
