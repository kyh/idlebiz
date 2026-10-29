import path from "node:path";
import type { Argv } from "@repo/agent-driver/registry";
import { RUNNER_IDS } from "@repo/domain/runners";
import type { RunnerId } from "@repo/domain/runners";

// macOS's own: one found on PATH could be anything.
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

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

/** The /dev nodes a toolchain writes: output sinks, terminals, dtrace's helper. */
const DEV_NODES = String.raw`(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/tty") (literal "/dev/ptmx") (literal "/dev/dtracehelper") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd"))`;

/** What a rule reaches: a path and all under it (a file is only itself), or every path starting with it. */
export interface Reach {
  match: "subpath" | "prefix";
  path: string;
}

/** A runner's home: the whole of it, what its runs write there, and what only its sign-in writes. */
export interface RunnerHome {
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
  runners: Record<RunnerId, RunnerHome>;
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
   * The run's own line to the company, a socket main listens on in a folder no run writes (the
   * save's or HOME's): this run connects to it, and no other run's seal names it, so no run calls
   * as another (control-plane.ts). Empty for a seal of no run, a probe's or a sign-in's.
   */
  apiSocket: readonly Reach[];
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
  namespaces: Record<RunnerId, Reach>;
  /**
   * Where claude keeps each folder's transcripts and memory, which the founder's own sessions
   * there resume and load: a claude run writes only its working directory's, when it has one.
   */
  claudeProjects: { projects: string; own: string | null };
}

// A sealed process cannot exec a setuid program, and /bin/ps is one: version managers (fnm) walk
// the process tree with it, and claude's shell snapshot runs them. It only reads.
// git's Keychain helper signs as the founder with no file to seal.
// A run connects to no socket but its own folders' and its line to the company (a later rule),
// DNS's and syslog's: the founder's
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

// The pasteboard answers over this, whichever program asks, as the Keychain does: the founder
// enters a key by pasting it, and the runs work on while it sits there.
const PASTEBOARD = String.raw`(deny mach-lookup (global-name "com.apple.pasteboard.1"))`;

// What the system does for a run outside the seal, as the founder: a filesystem mounted over a
// folder the founder runs programs from (the kernel checks a run's own mount, diskarbitrationd
// one `hdiutil attach` asks it for), a job launchd starts, and a preference cfprefsd writes, which
// it does for a caller allowed either this or a write to the plist itself.
const DONE_FOR_IT = [
  "(deny file-mount file-unmount)",
  "(deny job-creation)",
  "(deny user-preference-write)",
];

/**
 * Who is sealed: an employee run, or the founder's CLI sign-in. A run asks LaunchServices to open
 * nothing, launchd to start nothing, nothing to mount and cfprefsd to write nothing, since what
 * they start or write is outside the seal as the founder; it reads no pasteboard and writes no
 * account file. The sign-in opens the browser it signs in through and records the login it makes.
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
export const inside = (root: string, at: string): boolean => {
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
  runner: RunnerId,
  sealed: Sealed,
  argv: readonly string[],
): Argv => {
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
    ...(sealed === "run" ? ["(deny lsopen)", ...DONE_FOR_IT, SCRIPTING_CLIS, PASTEBOARD] : []),
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
      [...seal.writable, seal.namespaces[runner], ...seal.apiSocket].map(
        (at) => `(remote unix-socket ${reach(at)})`,
      ),
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
export const sealedCommand = (seal: Seal, runner: RunnerId, argv: readonly string[]): Argv =>
  commandUnder(seal, runner, "run", argv);

/** A runner's sign-in, sealed as its runs are but free to open the browser it signs in through and record the login. */
export const signInCommand = (seal: Seal, runner: RunnerId, argv: readonly string[]): Argv =>
  commandUnder(seal, runner, "sign-in", argv);
