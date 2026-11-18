import path from "node:path";
import { RUNNER_IDS } from "@repo/domain/runners";
import type { RunnerId } from "@repo/domain/runners";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** A command line: the program, then its arguments. */
export type Command = readonly [program: string, ...args: string[]];

const OPENED_AS_FOUNDER = [
  String.raw`(require-all (regex #"/\.git/") (require-not (regex #"/\.git/((objects|refs|logs|rebase-merge|rebase-apply|sequencer|rr-cache)(/|$)|(index|index\.stash\.[0-9]+|next-index-[0-9]+|HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|MERGE_MSG|MERGE_MODE|MERGE_RR|AUTO_MERGE|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|BISECT_[A-Z_]+|COMMIT_EDITMSG|SQUASH_MSG|TAG_EDITMSG|packed-refs(\.new)?|info/refs(_[A-Za-z0-9]+)?|shallow|gc\.pid|gc\.log)(\.lock)?$)")))`,
  String.raw`(regex #"/\.git/objects/info/(http-)?alternates")`,
  String.raw`(regex #"/\.claude/settings[^/]*$")`,
  String.raw`(regex #"/\.mcp\.json$")`,
  String.raw`(regex #"/\.vscode/(tasks|launch|settings)\.json$")`,
  String.raw`(regex #"/\.idea/")`,
  String.raw`(regex #"/\.envrc$")`,
];

const PROJECT_CODEX = String.raw`(regex #"/\.codex(/|$)")`;

const CODEX_IN_CODEX_HOME = String.raw`(regex #"/\.codex/(.+/)?\.codex(/|$)")`;

const HOLDING_FOLDERS = String.raw`(regex #"/\.(git|claude|vscode|idea)$")`;

const NODE_PREFERENCES = String.raw`(regex #"/Library/Preferences/[^/]+-nodejs(/|$)")`;

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
  /**
   * The folder where it is named and where it resolves, and, when the founder moved it, the one in
   * HOME with the account file beside it, which their own CLI still keeps: the other runner's runs
   * read none of it, and this runner's write none of it but its state and, claude's, the run's own
   * project folder; its sign-in writes the account file too.
   */
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
 * The sandbox a run starts under, on this machine. A run writes only where it is allowed to;
 * Seatbelt matches the path a symlink leads to, not the link, so each path reached through one is
 * named at both ends.
 */
export interface Sandbox {
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
   * save's or HOME's): this run connects to it, and no other run's sandbox names it, so no run calls
   * as another. Empty for a sandbox of no run, a probe's or a sign-in's.
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
  /**
   * What each deny reports itself as in the system log, where `watchDenials` reads it back: who
   * ran into it. Null for a sandbox no one watches, a probe's or a sign-in's.
   */
  label: string | null;
}

const BASE_PROFILE = String.raw`(version 1)
(allow default)
(allow process-exec (literal "/bin/ps") (with no-sandbox))
(deny process-exec (regex #"/git-credential-osxkeychain$"))
(deny network-outbound (remote unix-socket))
(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")) (remote unix-socket (literal "/private/var/run/syslog")))`;

const AGENT_SOCKET_WRITES = String.raw`(deny file-write* (regex #"^/private/(tmp|var/run)/com\.apple\.launchd\.[^/]+(/Listeners)?$"))
(deny file-write-unlink (regex #"/ssh-[^/]+(/agent\.[0-9]+)?$"))`;

const SCRIPTING_CLIS = String.raw`(deny process-exec (literal "/usr/bin/osascript") (literal "/usr/bin/osacompile") (literal "/usr/bin/automator") (literal "/usr/bin/shortcuts"))`;

const KEYCHAIN = String.raw`(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))`;

const PASTEBOARD = String.raw`(deny mach-lookup (global-name "com.apple.pasteboard.1"))`;

const DONE_FOR_IT = [
  "(deny file-mount file-unmount)",
  "(deny job-creation)",
  "(deny user-preference-write)",
];

type Confined = "run" | "sign-in";

const rule = (action: "allow" | "deny") => (operations: string, filters: readonly string[]) =>
  filters.length === 0 ? [] : [`(${action} ${operations} ${filters.join(" ")})`];

const allow = rule("allow");
const deny = rule("deny");

const hide = (filters: readonly string[]) =>
  filters.length === 0
    ? []
    : [`(deny file-read* file-write* ${filters.join(" ")} (with errno ENOENT))`];

/** Whether `at` is `root` or inside it. */
export const inside = (root: string, at: string) => {
  const relative = path.relative(root, at);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const foldersUpTo = (root: string, at: string) => {
  const folders: string[] = [];

  for (let dir = path.dirname(at); inside(root, dir) && dir !== path.dirname(dir);) {
    folders.push(dir);
    dir = path.dirname(dir);
  }

  return folders;
};

const commandUnder = (
  sandbox: Sandbox,
  runner: RunnerId,
  confined: Confined,
  argv: readonly string[],
) => {
  // WARNING: each path is a parameter, never quoted into the profile's source.
  const params: string[] = [];
  const param = (value: string) => `(param "P${params.push(value) - 1}")`;
  const reach = ({ match, path: at }: Reach) => `(${match} ${param(at)})`;
  const literal = (at: string) => `(literal ${param(at)})`;
  const other = RUNNER_IDS.filter((id) => id !== runner);

  const unreadable = [
    ...sandbox.unreadable,
    ...sandbox.runners[runner].personal,
    ...other.flatMap((id) => [...sandbox.runners[id].home, ...sandbox.runners[id].account]),
  ];

  const { account, home, state } = sandbox.runners[runner];
  const { own } = sandbox.claudeProjects;

  const ownProject: Reach[] =
    runner === "claude" && own !== null ? [{ match: "subpath", path: own }] : [];

  const scratch = [...sandbox.scratch, sandbox.namespaces[runner]];
  const inHome = [...state, ...ownProject, ...(confined === "sign-in" ? account : [])];
  const roots = [...scratch, ...inHome, ...sandbox.writable];
  const kept = sandbox.runsAsFounder;

  const above = [
    ...new Set(
      kept.flatMap(({ path: at }) =>
        roots.flatMap((root) => (inside(root.path, at) ? foldersUpTo(root.path, at) : [])),
      ),
    ),
  ];

  const codexHome = sandbox.runners.codex.folder;

  const projectCodex =
    path.basename(codexHome) === ".codex"
      ? `(require-all ${PROJECT_CODEX} (require-not (require-all ${reach({ match: "subpath", path: codexHome })} (require-not ${CODEX_IN_CODEX_HOME}))))`
      : PROJECT_CODEX;

  const profile = [
    BASE_PROFILE,
    ...(confined === "run" ? ["(deny lsopen)", ...DONE_FOR_IT, SCRIPTING_CLIS, PASTEBOARD] : []),
    ...(runner === "codex" ? [KEYCHAIN] : []),
    "(deny file-write*)",
    DEV_NODES,
    ...allow("file-write*", scratch.map(reach)),
    `(allow file-write* (require-all (prefix ${param(`${sandbox.preferences}${path.sep}`)}) ${NODE_PREFERENCES}))`,
    ...deny("file-write*", [...sandbox.save, ...home].map(reach)),
    ...allow("file-write*", [...sandbox.writable, ...inHome].map(reach)),
    ...deny("file-write*", [...kept, ...sandbox.sockets, ...sandbox.skillFolders].map(reach)),
    `(deny file-write* (require-any ${[...OPENED_AS_FOUNDER, projectCodex].join(" ")}))`,
    `(deny file-write-create file-write-unlink ${HOLDING_FOLDERS})`,
    ...deny("file-write-create file-write-unlink", [
      ...sandbox.writable.map(({ path: at }) => literal(at)),
      ...above.map(literal),
    ]),
    AGENT_SOCKET_WRITES,
    ...deny("file-read* file-write*", unreadable.map(reach)),
    ...hide(sandbox.runners[runner].absent.map(reach)),
    ...allow(
      "network-outbound",
      [...sandbox.writable, sandbox.namespaces[runner], ...sandbox.apiSocket].map(
        (at) => `(remote unix-socket ${reach(at)})`,
      ),
    ),
    ...deny(
      "network-outbound",
      sandbox.closedPorts.map((port) => `(remote tcp "localhost:${port}")`),
    ),
  ];

  const { label } = sandbox;

  const reported =
    label === null
      ? profile
      : profile
          .join("\n")
          .split("\n")
          .map((line) =>
            line.startsWith("(deny ")
              ? `${line.slice(0, -1)} (with message (param "LABEL")))`
              : line,
          );

  const defines = [
    ...params.flatMap((value, at) => ["-D", `P${at}=${value}`]),
    ...(label === null ? [] : ["-D", `LABEL=${label}`]),
  ];

  const command: Command = [SANDBOX_EXEC, "-p", reported.join("\n"), ...defines, ...argv];

  return command;
};

/** `argv` as a `runner` run starts it: under the profile, with this machine's paths. */
export const sandboxedCommand = (sandbox: Sandbox, runner: RunnerId, argv: readonly string[]) =>
  commandUnder(sandbox, runner, "run", argv);

/** A runner's sign-in, sandboxed as its runs are but free to open the browser it signs in through and record the login. */
export const signInCommand = (sandbox: Sandbox, runner: RunnerId, argv: readonly string[]) =>
  commandUnder(sandbox, runner, "sign-in", argv);
