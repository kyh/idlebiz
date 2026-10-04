import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runnerBin } from "@repo/agent-driver/detect";
import { RUNNER_IDS } from "@repo/agent-driver/runner";
import { z } from "zod";
import { ROOT_DIR } from "../paths";
import { SECRETS_PATH } from "../secrets";
import { pagePorts } from "../page-server";
import { DEV_PORT } from "@repo/contract/routes";
import type { AgentRunner, LoadReport } from "@repo/domain/domain";
import { errorMessage } from "@repo/domain/errors";
import { RefusalError } from "../refusal";

// macOS's own: one found on PATH could be anything.
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

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
 * Each runner's home, and in it the state its runs write: sessions, logs, caches, databases, its
 * refreshed login. Nothing else there is written, since the founder's own CLI loads and runs what
 * the rest holds (settings, instructions, hooks, skills, plugins, and any script a setting names,
 * a status line or a notifier). Each of `state` is a prefix, since a CLI writes a file through a
 * sibling it renames over it; one ending in a slash is only that folder. `account` is where the
 * CLI records the founder's account, in the home and beside it in HOME, each with every name that
 * starts with it: only the sign-in writes it. claude's transcripts and memory are `projects/`,
 * of which a run writes only its own folder's (`Seal.claudeProjects`). `personal` is what of the
 * founder's own its runs would load, in the home and in HOME, which they cannot even read: codex
 * loads every skill it can read, with no setting that leaves them all out, and their instructions
 * (`AGENTS.md`, or `AGENTS.override.md` in its place), whatever its config says; their memories
 * are kept from its prompt by the session's config, and from its reads here. A claude session
 * loads no user settings, so none of theirs. `absent` is what of the founder's its runs read as
 * missing, since the runner refuses to start on it unreadable: codex's rules, whose `allow`
 * decisions run a command without asking IdleBiz, and which codex loads whatever its config says.
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
  AgentRunner,
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
 * What the founder's own tools run from a folder the moment they open it: git's (a shell prompt
 * runs git status there), claude's project settings and MCP servers, codex's project config.
 * Held wherever a run writes, not only in its own folders: a folder is checked where it moves
 * to, never what it carries, so one built in TMPDIR and moved into a workspace would bring them
 * along. In a repository's folder a run writes only what git writes as it stages, commits,
 * branches, stashes, merges and rebases: the rest is what git obeys, its config and hooks and
 * every file that names another folder's (`commondir`, `worktrees/`, `modules/`, an alternate
 * object store).
 */
const OPENED_AS_FOUNDER = [
  String.raw`(require-all (regex #"/\.git/") (require-not (regex #"/\.git/((objects|refs|logs|rebase-merge|rebase-apply|sequencer|rr-cache)(/|$)|(index|index\.stash\.[0-9]+|next-index-[0-9]+|HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|MERGE_MSG|MERGE_MODE|MERGE_RR|AUTO_MERGE|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|BISECT_[A-Z_]+|COMMIT_EDITMSG|SQUASH_MSG|TAG_EDITMSG|packed-refs(\.new)?|info/refs(_[A-Za-z0-9]+)?|shallow|gc\.pid|gc\.log)(\.lock)?$)")))`,
  String.raw`(regex #"/\.git/objects/info/(http-)?alternates")`,
  String.raw`(regex #"/\.claude/settings[^/]*$")`,
  String.raw`(regex #"/\.mcp\.json$")`,
];

const PROJECT_CODEX = String.raw`(regex #"/\.codex(/|$)")`;

// codex's own home is named so too: inside it, only a `.codex` below it is a project's.
const CODEX_IN_CODEX_HOME = String.raw`(regex #"/\.codex/(.+/)?\.codex(/|$)")`;

const HOLDING_FOLDERS = String.raw`(regex #"/\.(git|claude)$")`;

// Where node CLIs keep their preferences (the `conf` package's folder on macOS), with no env to
// move it: create-next-app saves its answers there, and its atomic write retries a refusal until
// the stack overflows. Data only; no CLI runs anything from it.
const NODE_PREFERENCES = String.raw`(regex #"/Library/Preferences/[^/]+-nodejs(/|$)")`;

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

/** The /dev nodes a toolchain writes: output sinks, terminals, dtrace's helper. */
const DEV_NODES = String.raw`(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/tty") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd"))`;

/** What a rule reaches: a path and all under it (a file is only itself), or every path starting with it. */
interface Reach {
  match: "subpath" | "prefix";
  path: string;
}

/** A runner's home: the whole of it, what its runs write there, and what only its sign-in writes. */
interface RunnerHome {
  /** The home's folder, where it resolves. */
  folder: string;
  /** The folder where it is named and where it resolves: the other runner's runs read none of it. */
  home: readonly Reach[];
  state: readonly Reach[];
  account: readonly Reach[];
  /**
   * The founder's own skills, instructions and memories this runner's runs would load, which they
   * cannot read.
   */
  personal: readonly Reach[];
  /** What of the founder's this runner's runs read as missing, which they cannot write either. */
  absent: readonly Reach[];
}

/**
 * What an employee run is sealed with, on this machine. A run writes only where it is allowed
 * to; Seatbelt matches the path a symlink leads to, not the link, so each path reached through
 * one is named at both ends.
 */
export interface Seal {
  /** No run reads or writes these: the founder's logins and IdleBiz's own keys. */
  unreadable: readonly Reach[];
  /** Where every run writes besides its own folders: TMPDIR, the per-user cache, /private/tmp. */
  scratch: readonly Reach[];
  /** Per runner, its own home, which the other runner's runs cannot read. */
  runners: Record<AgentRunner, RunnerHome>;
  /**
   * The run's own folders, where the save resolves: its workspace, the shared one, its memory and
   * the tool cache. A run writes inside each but cannot remove, move or replace one.
   */
  writable: readonly Reach[];
  /**
   * What the founder runs or loads that falls inside a folder a run writes: the folders on main's
   * PATH and where their links lead, a terminal's shims in TMPDIR, and where a link in a runner's
   * home leads.
   */
  runsAsFounder: readonly Reach[];
  /** Sockets in a folder a run writes, of what acts as the founder: no run moves or replaces one. */
  sockets: readonly Reach[];
  /**
   * `.agents` in each of the run's own folders, where codex finds skills in a folder a session
   * is handed or works in: no run writes one, so none leaves a skill for a later run to load.
   */
  skillFolders: readonly Reach[];
  /** The save, which a run writes only its own folders of, where it is named and where it resolves. */
  save: readonly Reach[];
  /** The founder's ~/Library/Preferences, where node CLIs keep theirs. */
  preferences: string;
  /**
   * Loopback ports no run reaches: a debugger listening there takes orders from anyone, and main's
   * page answers the founder's own window.
   */
  closedPorts: readonly number[];
  /** Per runner, the agent-browser namespace its runs with these folders start their daemons in. */
  namespaces: Record<AgentRunner, Reach>;
  /**
   * Where claude keeps each folder's transcripts and memory, which the founder's own sessions
   * there resume and load: a claude run writes only its working directory's, when it has one.
   */
  claudeProjects: { projects: string; own: string | null };
}

// A sealed process cannot exec a setuid program, and /bin/ps is one: version managers (fnm) walk
// the process tree with it, and claude's shell snapshot runs them. It only reads.
// git's Keychain helper signs as the founder with no file to seal.
// A run connects to no socket but its own (a later rule), DNS's and syslog's: the founder's
// TMPDIR and /tmp are full of what answers as the founder, from each Chromium or Electron app's
// SingletonSocket, which hands the running app a URL to open, to ssh and container agents.
const BASE_PROFILE = String.raw`(version 1)
(allow default)
(allow process-exec (literal "/bin/ps") (with no-sandbox))
(deny process-exec (regex #"/git-credential-osxkeychain$"))
(deny network-outbound (remote unix-socket))
(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")) (remote unix-socket (literal "/private/var/run/syslog")))`;

// launchd's ssh agent and one started from a terminal (`ssh-*/agent.<pid>`, wherever its TMPDIR
// is) sign as the founder, in folders a run writes: neither is moved or replaced. Last in their
// block, so they hold inside every folder a run writes.
const AGENT_SOCKET_WRITES = String.raw`(deny file-write* (regex #"^/private/(tmp|var/run)/com\.apple\.launchd\.[^/]+(/Listeners)?$"))
(deny file-write-unlink (regex #"/ssh-[^/]+(/agent\.[0-9]+)?$"))`;

// The CLIs that drive other apps by Apple Event: one told to run a command runs it unsealed. A
// program a run builds can still send one; macOS asks the founder before IdleBiz controls an app.
const SCRIPTING_CLIS = String.raw`(deny process-exec (literal "/usr/bin/osascript") (literal "/usr/bin/osacompile") (literal "/usr/bin/automator") (literal "/usr/bin/shortcuts"))`;

// The Keychain answers over these, whichever program asks: a copy of an Apple binary gets past a
// rule on its path, never this. claude keeps its own login there, so only codex runs lose it.
const KEYCHAIN = String.raw`(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))`;

/**
 * Who is sealed: an employee run, or the founder's CLI sign-in. A run asks LaunchServices to open
 * nothing, since an app it starts runs outside the seal as the founder, and writes no account
 * file; the sign-in opens the browser it signs in through and records the login it makes.
 */
type Sealed = "run" | "sign-in";

// A rule with no filter reaches everything, so one with nothing to reach is left out.
const rule =
  (action: "allow" | "deny") =>
  (operations: string, filters: readonly string[]): string[] =>
    filters.length === 0 ? [] : [`(${action} ${operations} ${filters.join(" ")})`];
const allow = rule("allow");
const deny = rule("deny");
const hide = (filters: readonly string[]): string[] =>
  filters.length === 0
    ? []
    : [`(deny file-read* file-write* ${filters.join(" ")} (with errno ENOENT))`];

/** Whether `at` is `root` or inside it. */
const inside = (root: string, at: string): boolean => {
  const relative = path.relative(root, at);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** Every folder above `at` inside `root`, `root` itself included. */
const foldersUpTo = (root: string, at: string): string[] => {
  const folders: string[] = [];
  for (let dir = path.dirname(at); inside(root, dir) && dir !== path.dirname(dir);) {
    folders.push(dir);
    dir = path.dirname(dir);
  }
  return folders;
};

const commandUnder = (
  seal: Seal,
  runner: AgentRunner,
  sealed: Sealed,
  argv: readonly string[],
): string[] => {
  // Each path is a parameter, never quoted into the profile's source.
  const params: string[] = [];
  const param = (value: string): string => `(param "P${params.push(value) - 1}")`;
  const reach = ({ match, path: at }: Reach): string => `(${match} ${param(at)})`;
  const literal = (at: string): string => `(literal ${param(at)})`;
  const other = RUNNER_IDS.filter((id) => id !== runner);
  const unreadable = [
    ...seal.unreadable,
    ...seal.runners[runner].personal,
    ...other.flatMap((id) => [...seal.runners[id].home, ...seal.runners[id].account]),
  ];
  const { account, home, state } = seal.runners[runner];
  const { own } = seal.claudeProjects;
  const ownProject: Reach[] =
    runner === "claude" && own !== null ? [{ match: "subpath", path: own }] : [];
  const scratch = [...seal.scratch, seal.namespaces[runner]];
  // what the runner writes in its home; the sign-in records the login too
  const inHome = [...state, ...ownProject, ...(sealed === "sign-in" ? account : [])];
  const roots = [...scratch, ...inHome, ...seal.writable];
  const kept = seal.runsAsFounder;
  // A folder above a kept path, moved, would carry it out from under its rule; made where there
  // is none yet, as a link or a folder moved in, it would put the run's own files under it.
  const above = [
    ...new Set(
      kept.flatMap(({ path: at }) =>
        roots.flatMap((root) => (inside(root.path, at) ? foldersUpTo(root.path, at) : [])),
      ),
    ),
  ];
  const codexHome = seal.runners.codex.folder;
  const projectCodex =
    path.basename(codexHome) === ".codex"
      ? `(require-all ${PROJECT_CODEX} (require-not (require-all ${reach({ match: "subpath", path: codexHome })} (require-not ${CODEX_IN_CODEX_HOME}))))`
      : PROJECT_CODEX;
  const profile = [
    BASE_PROFILE,
    ...(sealed === "run" ? ["(deny lsopen)", SCRIPTING_CLIS] : []),
    ...(runner === "codex" ? [KEYCHAIN] : []),
    "(deny file-write*)",
    DEV_NODES,
    ...allow("file-write*", scratch.map(reach)),
    `(allow file-write* (require-all (prefix ${param(`${seal.preferences}${path.sep}`)}) ${NODE_PREFERENCES}))`,
    // Either may sit in TMPDIR, as a test's do: of the save a run writes only its own folders, of
    // its runner's home only the state.
    ...deny("file-write*", [...seal.save, ...home].map(reach)),
    ...allow("file-write*", [...seal.writable, ...inHome].map(reach)),
    // Seatbelt obeys the last rule a path matches: every rule from here on holds inside the
    // folders allowed above.
    ...deny("file-write*", [...kept, ...seal.sockets, ...seal.skillFolders].map(reach)),
    `(deny file-write* (require-any ${[...OPENED_AS_FOUNDER, projectCodex].join(" ")}))`,
    // nor is either folder they sit in removed, moved or made, which would carry them out from
    // under the rules above
    `(deny file-write-create file-write-unlink ${HOLDING_FOLDERS})`,
    // A subpath reaches the folder itself, which a run could otherwise remove and leave a link
    // in place of, for the next run to write through.
    ...deny("file-write-create file-write-unlink", [
      ...seal.writable.map(({ path: at }) => literal(at)),
      ...above.map(literal),
    ]),
    AGENT_SOCKET_WRITES,
    ...deny("file-read* file-write*", unreadable.map(reach)),
    ...hide(seal.runners[runner].absent.map(reach)),
    ...allow(
      "network-outbound",
      [...seal.writable, seal.namespaces[runner]].map((at) => `(remote unix-socket ${reach(at)})`),
    ),
    ...deny(
      "network-outbound",
      seal.closedPorts.map((port) => `(remote tcp "localhost:${port}")`),
    ),
  ].join("\n");
  const defines = params.flatMap((value, at) => ["-D", `P${at}=${value}`]);
  return [SANDBOX_EXEC, "-p", profile, ...defines, ...argv];
};

/** `argv` as a `runner` run starts it: under the profile, with this machine's paths. */
export const sealedCommand = (seal: Seal, runner: AgentRunner, argv: readonly string[]): string[] =>
  commandUnder(seal, runner, "run", argv);

/** A runner's sign-in, sealed as its runs are but free to open the browser it signs in through and record the login. */
export const signInCommand = (seal: Seal, runner: AgentRunner, argv: readonly string[]): string[] =>
  commandUnder(seal, runner, "sign-in", argv);

/** How a program run under the profile ended: its exit code, or null when it never ran or was killed. */
export type SealProbe = (
  argv: readonly string[],
  env: Record<string, string>,
) => Promise<number | null>;

const PROBE_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

const Exited = z.object({ code: z.number() });

const runProbe: SealProbe = async ([bin = SANDBOX_EXEC, ...args], env) => {
  try {
    await execFileAsync(bin, args, { env, timeout: PROBE_TIMEOUT_MS });
    return 0;
  } catch (error) {
    const exited = Exited.safeParse(error);
    return exited.success ? exited.data.code : null;
  }
};

// Exit 0 only when the sealed canary cannot be read (3 when it can) and a new file beside it,
// where no rule allows a write, cannot be made (5 when it can).
const CANARIES = `const fs = require("node:fs");
const [canary, fresh] = process.argv.slice(1);
try { fs.readFileSync(canary); process.exit(3); } catch (error) { if (error.code !== "EPERM") process.exit(4); }
try { fs.writeFileSync(fresh, "x", { flag: "wx" }); process.exit(5); } catch (error) { process.exit(error.code === "EPERM" ? 0 : 6); }`;

const refusalFor = (code: number | null): string | null => {
  if (code === 0) {
    return null;
  }
  if (code === null) {
    return "IdleBiz could not run macOS's sandbox-exec, which every employee run starts inside, so none will start.";
  }
  if (code === 3) {
    return "IdleBiz's sandbox let a run read a file it seals, so no employee run will start.";
  }
  if (code === 5) {
    return "IdleBiz's sandbox let a run write outside its own folders, so no employee run will start.";
  }
  return `An employee run could not start inside IdleBiz's sandbox (exit ${code}), so none will.`;
};

/**
 * Why no run can be sealed, or null when every runner's can: under each one's profile, a canary
 * sealed the way secrets.json is must be unreadable, a file where no rule allows a write must
 * not be made, and the runtime the ACP adapters run on must start. The canaries sit in TMPDIR,
 * so the probe's profile leaves out the scratch folders every run writes. Free: nothing here
 * asks a model.
 */
export const checkSeal = async (
  seal: Seal,
  probe: SealProbe = runProbe,
): Promise<string | null> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "idlebiz-seal-")));
  try {
    const canary = path.join(dir, "secrets.json");
    await writeFile(canary, "canary");
    const probed: Seal = {
      ...seal,
      scratch: [],
      unreadable: [...seal.unreadable, { match: "subpath", path: canary }],
    };
    const codes = await Promise.all(
      RUNNER_IDS.map((runner) =>
        probe(
          sealedCommand(probed, runner, [
            process.execPath,
            "-e",
            CANARIES,
            canary,
            path.join(dir, `written-by-${runner}`),
          ]),
          {},
        ),
      ),
    );
    return codes.map(refusalFor).find((refusal) => refusal !== null) ?? null;
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

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
  runner: AgentRunner,
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
  runner: AgentRunner,
  folders: readonly string[],
): string =>
  `idlebiz-${createHash("sha256")
    .update([save, runner, ...folders].join("\0"))
    .digest("hex")
    .slice(0, 8)}`;

/** The agent-browser namespace `runner`'s runs under `seal` start their daemons in. */
export const namespaceUnder = (seal: Seal, runner: AgentRunner): string =>
  path.basename(seal.namespaces[runner].path);

/** Where agent-browser keeps its daemons' sockets for a run, whatever the founder's env says. */
export const browserSocketDir = (): string => path.join(homedir(), ".agent-browser");

/** The seal of a run under `home`, resolved as it stands on disk now. */
export const sealFor = async ({
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
  const namespaceOf = (runner: AgentRunner): Reach => ({
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
 * The seal of a run that writes `writable`, resolved as this machine stands now: its home, main's
 * PATH and the CLIs on it. Each run resolves its own: a login that turns into a symlink after
 * boot is sealed where it leads from the next run on.
 */
export const machineSeal = async (writable: readonly string[]): Promise<Seal> => {
  const agent = process.env.SSH_AUTH_SOCK;
  const cache = await darwinUserCacheDir();
  // macOS's own libraries write its per-user temp folder whatever TMPDIR says
  const temps = [tmpdir(), path.join(path.dirname(cache), "T")];
  return await sealFor({
    clis: RUNNER_IDS.map(runnerBin),
    closedPorts: [...CLOSED_PORTS, ...pagePorts()],
    env: process.env,
    home: homedir(),
    mainOnly: [SECRETS_PATH],
    pathDirs: (process.env.PATH ?? "").split(path.delimiter),
    save: ROOT_DIR,
    scratch: [...temps, cache, "/private/tmp"],
    shims: temps.flatMap((temp) => TERMINAL_SHIMS.map((name) => path.join(temp, name))),
    sshAgent: agent === undefined || agent === "" ? null : agent,
    writable,
  });
};

/** Whether employee runs start sealed; a refusal is the sentence the founder reads. */
export type SealState = { kind: "sealed" } | { kind: "refused"; reason: string };

/** Whether this machine can seal runs at all, checked before any run starts. */
export const sealRuns = async (): Promise<SealState> => {
  try {
    const refusal = await checkSeal(await machineSeal([]));
    return refusal === null ? { kind: "sealed" } : { kind: "refused", reason: refusal };
  } catch (error) {
    const reason = `IdleBiz could not check the sandbox employee runs start inside (${errorMessage(error)}), so none will start.`;
    return { kind: "refused", reason };
  }
};

/** Boot's report with the seal's refusal beside what it left out of the save: every run, for want of the sandbox. */
export const notingSeal = (report: LoadReport, refusal: string | null): LoadReport =>
  refusal === null
    ? report
    : {
        ...report,
        skipped: [
          ...report.skipped,
          { error: refusal, kind: "seal", newerBuild: false, path: SANDBOX_EXEC },
        ],
      };
