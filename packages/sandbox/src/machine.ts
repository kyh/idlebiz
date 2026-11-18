import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readdir, readlink, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RunnerId } from "@repo/domain/runners";
import { inside } from "./profile";
import type { Reach, RunnerHome, Sandbox } from "./profile";

/** A folder no run may be handed to write: one outside the save, or reached through a symlink. */
export type FolderRefusal =
  | { kind: "outside-save"; folder: string }
  | { kind: "linked"; folder: string; link: string };

/** Thrown for a folder no sandbox can hand a run, which the host words for whoever asked. */
export class FolderRefusedError extends Error {
  readonly refusal: FolderRefusal;

  constructor(refusal: FolderRefusal) {
    super(`no sandbox writes ${refusal.folder}: ${refusal.kind}`);
    this.name = "FolderRefusedError";
    this.refusal = refusal;
  }
}

const LOGINS = [
  ".ssh",
  ".config/gh",
  ".config/hub",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".config/git/credentials",
  ".aws",
  ".azure",
  ".oci",
  ".kube",
  ".docker",
  ".gnupg",
  ".config/gcloud",
  "Library/Application Support/doctl",
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
  ".terraformrc",
  ".pulumi/credentials.json",
  ".vault-token",
  ".pgpass",
  ".my.cnf",
  ".mylogin.cnf",
  ".pypirc",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gem/credentials",
  ".local/share/gem/credentials",
  ".m2/settings.xml",
  ".m2/settings-security.xml",
  ".gradle/gradle.properties",
  ".cache/huggingface/token",
  ".cache/huggingface/stored_tokens",
  ".sentryclirc",
  ".config/configstore",
  ".config/op",
  ".config/github-copilot",
  ".appstoreconnect",
  ".tauri",
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

const RUNNER_HOMES = {
  claude: {
    absent: [],
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
      "auth.json",
      "installation_id",
      "version.json",
      "models_cache.json",
      "internal_storage.json",
      ".sandbox_migration",
      ".personality_migration",
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

const SCRATCH_SOCKETS = [
  path.join(tmpdir(), "podman"),
  "/private/tmp/cc-socks",
  "/private/tmp/codex-browser-use",
  "/private/tmp/com.openai.sky.CUAService",
];

const TERMINAL_SHIMS = ["cmux-cli-shims"];

const DEBUGGER_PORTS = [9222, 9229];

/** The path Seatbelt sees for `file`: the real path of the deepest part that exists, the rest after it. */
export const realPathOf: (file: string) => Promise<string> = async (file) => {
  try {
    return await realpath(file);
  } catch {
    const parent = path.dirname(file);

    return parent === file ? file : path.join(await realPathOf(parent), path.basename(file));
  }
};

const reachOf = async (named: string, match: Reach["match"] = "subpath") => {
  const resolved = await realPathOf(named);

  return [named, ...(resolved === named ? [] : [resolved])].map(
    (at) =>
      ({
        match,
        path: at,
      }) satisfies Reach,
  );
};

const reachesOf = async (paths: readonly string[], match: Reach["match"] = "subpath") => {
  const reaches = await Promise.all(paths.map((at) => reachOf(at, match)));

  return reaches.flat();
};

const runnable = async (file: string) => {
  try {
    await access(file, constants.X_OK);

    return true;
  } catch {
    return false;
  }
};

const foundOn = async (command: string, pathDirs: readonly string[]) => {
  if (command.includes(path.sep)) {
    return [path.resolve(command)];
  }

  const files = pathDirs.map((dir) => path.join(dir, command));
  const runs = await Promise.all(files.map(runnable));

  return files.filter((_file, at) => runs[at] === true);
};

const MAX_LINKS = 32;

const linkChain = async (file: string) => {
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

const linksIn = async (folders: readonly string[]) => {
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

const homeLinkTargets = async (home: string) => {
  const entries = await readdir(home, { withFileTypes: true }).catch(() => []);

  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(home, entry.name));

  const links = await linksIn([home, ...folders]);
  const chains = await Promise.all(links.map(linkChain));

  return chains.flatMap((chain) => chain.slice(1));
};

const ownFolders = async (save: string, folders: readonly string[]) => {
  const realSave = await realPathOf(save);

  return await Promise.all(
    folders.map(async (folder) => {
      const inSave = path.relative(save, folder);
      const parts = inSave.split(path.sep);

      if (inSave === "" || path.isAbsolute(inSave) || parts[0] === "..") {
        throw new FolderRefusedError({ folder, kind: "outside-save" });
      }

      for (let depth = 1; depth <= parts.length; depth += 1) {
        const at = path.join(save, ...parts.slice(0, depth));
        const stats = await lstat(at).catch(() => null);

        if (stats?.isSymbolicLink() === true) {
          throw new FolderRefusedError({ folder, kind: "linked", link: at });
        }
      }

      return { match: "subpath", path: path.join(realSave, inSave) } satisfies Reach;
    }),
  );
};

const runnerHomeOf = async (
  home: string,
  runner: RunnerId,
  env: Readonly<Record<string, string | undefined>>,
) => {
  const { absent, account, dir, override, personal, state } = RUNNER_HOMES[runner];
  const moved = env[override];
  const inHome = moved === undefined || moved === "";
  const usual = path.join(home, dir);
  const folder = inHome ? usual : path.resolve(moved);

  const leftBehind = inHome
    ? []
    : [
        ...((await realPathOf(folder)) === (await realPathOf(usual)) ? [] : await reachOf(usual)),
        ...(await reachesOf(
          account.map((name) => path.join(home, name)),
          "prefix",
        )),
      ];

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
    home: [...(await reachOf(folder)), ...leftBehind],
    personal: await reachesOf([
      ...personal.home.map((name) => path.join(folder, name)),
      ...personal.user.map((name) => path.join(home, name)),
    ]),
    state: states.flat(),
  } satisfies RunnerHome;
};

const claudeProjectOf = (claudeHome: string, cwd: string) =>
  path.join(claudeHome, "projects", cwd.replaceAll(/[^a-zA-Z0-9]/gu, "-"));

const execFileAsync = promisify(execFile);

const darwinUserCacheDir = async () => {
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
export const browserNamespace = (save: string, runner: RunnerId, folders: readonly string[]) =>
  `idlebiz-${createHash("sha256")
    .update([save, runner, ...folders].join("\0"))
    .digest("hex")
    .slice(0, 8)}`;

/** The agent-browser namespace `runner`'s runs under `sandbox` start their daemons in. */
export const namespaceUnder = (sandbox: Sandbox, runner: RunnerId) =>
  path.basename(sandbox.namespaces[runner].path);

/** Where agent-browser keeps its daemons' sockets for a run, whatever the founder's env says. */
export const browserSocketDir = () => path.join(homedir(), ".agent-browser");

/** The sandbox of a run under `home`, resolved as it stands on disk now. */
export const sandboxFor = async ({
  apiSocket = null,
  clis,
  closedPorts,
  env,
  home,
  label = null,
  hostOnly,
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
  /** Folders a terminal runs the founder's programs from that the host's PATH need not name. */
  shims: readonly string[];
  /** Loopback ports whose listener would take orders from anyone, as the founder. */
  closedPorts: readonly number[];
  /** The host's env, where a runner's home may have been moved. */
  env: Readonly<Record<string, string | undefined>>;
  /** What only the host touches, with every name that starts with it: a file is written through `<file>.tmp`. */
  hostOnly: readonly string[];
  /** The founder's ssh agent, when the host's env names one. */
  sshAgent: string | null;
  /** The save, where a run writes only its own folders. */
  save: string;
  /** The host's PATH, the login shell's folders and the installer's on it whether they exist yet or not. */
  pathDirs: readonly string[];
  /** The runner CLIs as the host names them, a command on PATH or a path, which the founder runs unsandboxed. */
  clis: readonly string[];
  /** The run's own folders, each in the save, its working directory first. */
  writable: readonly string[];
  /** The socket the host answers this run's company tools on, when it is a run's sandbox. */
  apiSocket?: string | null;
  /** What this run's denials report themselves as (`Sandbox.label`). */
  label?: string | null;
}) => {
  const realHome = await realPathOf(home);

  const under = (names: readonly string[]) =>
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

  const namespaceOf = (runner: RunnerId) =>
    ({
      match: "subpath",
      path: path.join(
        realHome,
        ".agent-browser",
        "namespaces",
        browserNamespace(save, runner, folders),
      ),
    }) satisfies Reach;

  const namespaces = { claude: namespaceOf("claude"), codex: namespaceOf("codex") };

  const roots = [
    ...scratchReaches,
    ...claude.state,
    ...codex.state,
    ...Object.values(namespaces),
    ...own,
  ];

  const onPathDirs = [...new Set(pathDirs.filter((dir) => path.isAbsolute(dir)))];
  const found = await Promise.all(clis.map((cli) => foundOn(cli, onPathDirs)));
  const runs = [...new Set([...found.flat(), ...(await linksIn(onPathDirs))])];
  const chains = await Promise.all(runs.map(linkChain));
  const programs = chains.flat().map((at) => path.dirname(at));
  const linked = await Promise.all([claude.folder, codex.folder].map(homeLinkTargets));

  const candidates = await reachesOf([
    ...new Set([...onPathDirs, ...programs, ...shims, ...linked.flat()]),
  ]);

  const inRoot = ({ path: at }: Reach) =>
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
    label,
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
    unreadable: [...(await under(LOGINS)), ...(await reachesOf(hostOnly, "prefix"))],
    writable: own,
  } satisfies Sandbox;
};

/** What of a run's sandbox is the host's to say; the rest is this machine's. */
export interface HostSandbox {
  /** The host's state folder, where a run writes only its own folders. */
  save: string;
  /** The run's own folders, each in the save, its working directory first. */
  writable: readonly string[];
  /** The socket the host answers this run on, or null for a sandbox of no run. */
  apiSocket: string | null;
  /** The runner CLIs as the host names them, a command on PATH or a path. */
  clis: readonly string[];
  /** The host's own loopback ports, closed beside the debuggers'. */
  closedPorts: readonly number[];
  /** What only the host touches, with every name that starts with it. */
  hostOnly: readonly string[];
  /** What this run's denials report themselves as, or null for none. */
  label: string | null;
}

/**
 * The sandbox of a run, resolved as this machine stands now: its home, PATH and the CLIs on it.
 * Each run resolves its own: a login that turns into a symlink after boot is sandboxed where it
 * leads from the next run on.
 */
export const machineSandbox = async (host: HostSandbox) => {
  const agent = process.env.SSH_AUTH_SOCK;
  const cache = await darwinUserCacheDir();
  const temps = [tmpdir(), path.join(path.dirname(cache), "T")];

  return await sandboxFor({
    ...host,
    closedPorts: [...DEBUGGER_PORTS, ...host.closedPorts],
    env: process.env,
    home: homedir(),
    pathDirs: (process.env.PATH ?? "").split(path.delimiter),
    scratch: [...temps, cache, "/private/tmp"],
    shims: temps.flatMap((temp) => TERMINAL_SHIMS.map((name) => path.join(temp, name))),
    sshAgent: agent === undefined || agent === "" ? null : agent,
  });
};
