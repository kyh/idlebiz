import { execFile } from "node:child_process";
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
import { PUSH_STAGING_DIR } from "@/main/git-push";
import { ROOT_DIR } from "@/main/paths";
import { SECRETS_PATH } from "@/main/secrets";
import type { AgentRunner, LoadReport } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";
import { RefusalError } from "@/shared/refusal";

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
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/BraveSoftware",
  "Library/Cookies",
];

/** What runs as the founder later, under HOME: a run reads it but never writes it. */
const RUN_LATER = [
  "Library/LaunchAgents",
  ".config",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".zlogout",
  ".zsh_sessions",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".bash_sessions",
  ".profile",
  ".inputrc",
  ".gitconfig",
];

// zsh reads its startup files, or their compiled .zwc when newer, from wherever ZDOTDIR points,
// and ~/.zshenv can set it where main never looks; Terminal sources .zsh_sessions/ on a restore.
const ZSH_STARTUP = [
  String.raw`(regex #"/\.z(shenv|profile|shrc|login|logout)(\.zwc)?$")`,
  String.raw`(regex #"/\.zsh_sessions(/|$)")`,
];

/** Agents under HOME that sign as the founder over a socket: 1Password's and Secretive's. */
const AGENT_SOCKETS = [
  "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
  "Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh",
];

/**
 * What a run gives up besides the founder's logins: the other runner's login (every name in
 * HOME that starts with it, so ~/.claude.json goes with ~/.claude), and the Keychain unless its
 * own login is kept there, as claude's is.
 */
const RUNNER_SEALS = {
  claude: { keychain: "open", otherLogin: ".codex" },
  codex: { keychain: "sealed", otherLogin: ".claude" },
} as const satisfies Record<AgentRunner, { keychain: "open" | "sealed"; otherLogin: string }>;

/** What a rule reaches: a path and all under it (a file is only itself), or every path starting with it. */
interface Reach {
  match: "subpath" | "prefix";
  path: string;
}

/**
 * What an employee run is sealed with, on this machine. Seatbelt matches the path a symlink
 * leads to, not the link, so a path reached through one is sealed at both ends.
 */
export interface Seal {
  /** No run reads or writes these: the founder's logins, IdleBiz's own keys and where main stages a push. */
  unreadable: readonly Reach[];
  /** A run reads these but never writes them: what runs as the founder later. */
  unwritable: readonly Reach[];
  /**
   * A run writes these only inside `writable`: the save, every folder on main's PATH, there yet
   * or not, the tree each symlink in one and each runner CLI on it lands in, and IdleBiz's own,
   * which the founder runs unsealed. A shim that picks its program when it runs is not followed.
   */
  guarded: readonly Reach[];
  /**
   * The run's own folders, where the save resolves: its workspace, the shared one, its memory and
   * the tool cache. A run writes inside each but cannot remove, move or replace one.
   */
  writable: readonly Reach[];
  /** Per runner, the other runner's login, which its runs cannot read or write either. */
  otherLogin: Record<AgentRunner, readonly Reach[]>;
  /** Sockets of agents that sign as the founder, which no run reaches, moves or links. */
  agents: readonly Reach[];
}

/**
 * Whose process a profile seals: a runner's run, or main's probe of the founder's login shell,
 * which keeps neither runner's login nor the Keychain.
 */
export type Sealed = AgentRunner | "shell";

// git's Keychain helper and macOS's own ssh agent sign as the founder with no file to seal, and
// the agent's folder stays put: renamed, its socket would leave the rule behind. An ssh-agent
// started from a terminal names its socket `ssh-*/agent.<pid>` wherever its TMPDIR is.
const BASE_PROFILE = String.raw`(version 1)
(allow default)
(deny process-exec (regex #"/git-credential-osxkeychain$"))
(deny network-outbound (regex #"^/private/(tmp|var/run)/com\.apple\.launchd\.[^/]+/Listeners$"))
(deny network-outbound (remote unix-socket (regex #"/ssh-[^/]+/agent\.[0-9]+$")))
(deny file-write* (regex #"^/private/(tmp|var/run)/com\.apple\.launchd\.[^/]+(/Listeners)?$"))`;

// The CLIs that drive other apps by Apple Event: one told to run a command runs it unsealed. A
// program a run builds can still send one; macOS asks the founder before IdleBiz controls an app.
const SCRIPTING_CLIS = String.raw`(deny process-exec (literal "/usr/bin/osascript") (literal "/usr/bin/osacompile") (literal "/usr/bin/automator") (literal "/usr/bin/shortcuts"))`;

/**
 * What a sealed process may ask LaunchServices to open. An app LaunchServices starts runs outside
 * the seal as the founder, so a run opens nothing; only the founder's CLI sign-in opens the browser.
 */
type Opens = "nothing" | "the browser";

// A rule with no filter reaches everything, so one with nothing to reach is left out.
const rule =
  (action: "allow" | "deny") =>
  (operations: string, filters: readonly string[]): string[] =>
    filters.length === 0 ? [] : [`(${action} ${operations} ${filters.join(" ")})`];
const allow = rule("allow");
const deny = rule("deny");

/** Every folder above `paths` but the root. */
const foldersAbove = (paths: readonly string[]): string[] => {
  const folders = new Set<string>();
  for (const at of paths) {
    for (let dir = path.dirname(at); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      folders.add(dir);
    }
  }
  return [...folders];
};

const commandUnder = (
  seal: Seal,
  sealed: Sealed,
  opens: Opens,
  argv: readonly string[],
): string[] => {
  // Each path is a parameter, never quoted into the profile's source.
  const params: string[] = [];
  const param = (value: string): string => `(param "P${params.push(value) - 1}")`;
  const reach = ({ match, path: at }: Reach): string => `(${match} ${param(at)})`;
  const logins =
    sealed === "shell"
      ? RUNNER_IDS.flatMap((runner) => seal.otherLogin[runner])
      : seal.otherLogin[sealed];
  const unreadable = [...seal.unreadable, ...logins];
  const unwritable = [...seal.unwritable, ...seal.agents];
  const kept = [...unreadable, ...unwritable, ...seal.guarded].map(({ path: at }) => at);
  const keychain = sealed === "shell" ? "sealed" : RUNNER_SEALS[sealed].keychain;
  const literal = (at: string): string => `(literal ${param(at)})`;
  const profile = [
    BASE_PROFILE,
    ...(opens === "nothing" ? ["(deny lsopen)", SCRIPTING_CLIS] : []),
    ...deny("file-write*", seal.guarded.map(reach)),
    // Seatbelt obeys the last rule a path matches: this reopens the run's own folders, and every
    // rule after it holds inside them too.
    ...allow("file-write*", seal.writable.map(reach)),
    // A subpath reaches the folder itself, which a run could otherwise remove and leave a link
    // in place of, for the next run to write through.
    ...deny(
      "file-write-create file-write-unlink",
      seal.writable.map(({ path: at }) => literal(at)),
    ),
    ...deny("file-read* file-write*", unreadable.map(reach)),
    ...deny("file-write*", [...unwritable.map(reach), ...ZSH_STARTUP]),
    // Moving a folder above a sealed path would carry it out from under its rule, and making one
    // that is not there yet, as a link or a folder moved in, would put the run's own files under it.
    ...deny("file-write-create file-write-unlink", foldersAbove(kept).map(literal)),
    ...(keychain === "sealed" ? ['(deny process-exec (literal "/usr/bin/security"))'] : []),
    // A socket answers connect() whatever the file rules say, so an agent listening under a
    // sealed path is sealed here too.
    ...deny(
      "network-outbound",
      [...unreadable, ...seal.agents].map((at) => `(remote unix-socket ${reach(at)})`),
    ),
  ].join("\n");
  const defines = params.flatMap((value, at) => ["-D", `P${at}=${value}`]);
  return [SANDBOX_EXEC, "-p", profile, ...defines, ...argv];
};

/** `argv` as a process `sealed` names starts it: under the profile, with this machine's paths. */
export const sealedCommand = (seal: Seal, sealed: Sealed, argv: readonly string[]): string[] =>
  commandUnder(seal, sealed, "nothing", argv);

/** A runner's sign-in, sealed as its runs are but free to open the browser it signs in through. */
export const signInCommand = (seal: Seal, runner: AgentRunner, argv: readonly string[]): string[] =>
  commandUnder(seal, runner, "the browser", argv);

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

// Exit 0 only when the canary the profile seals cannot be read; 3 when it can.
const READ_CANARY = `try { require("node:fs").readFileSync(process.argv[1]); process.exit(3); } catch (error) { process.exit(error.code === "EPERM" ? 0 : 4); }`;

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
  return `An employee run could not start inside IdleBiz's sandbox (exit ${code}), so none will.`;
};

/**
 * Why no run can be sealed, or null when every runner's can: under each one's profile, a canary
 * sealed the way secrets.json is must be unreadable, and the runtime the ACP adapters run on
 * must start. Free: nothing here asks a model.
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
      unreadable: [...seal.unreadable, { match: "subpath", path: canary }],
    };
    const codes = await Promise.all(
      RUNNER_IDS.map((runner) =>
        probe(sealedCommand(probed, runner, [process.execPath, "-e", READ_CANARY, canary]), {
          ELECTRON_RUN_AS_NODE: "1",
        }),
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

/**
 * What spawning `command` with `pathDirs` as PATH may run: itself when it names a path, else
 * every copy on PATH, not just the first, since a shim found first can run the next one.
 */
/** Whether `file` is there, and can be run when `mode` asks for that. */
const reachable = async (file: string, mode?: number): Promise<boolean> => {
  try {
    await access(file, mode);
    return true;
  } catch {
    return false;
  }
};

const foundOn = async (command: string, pathDirs: readonly string[]): Promise<string[]> => {
  if (command.includes(path.sep)) {
    return [path.resolve(command)];
  }
  const files = pathDirs.map((dir) => path.join(dir, command));
  const runs = await Promise.all(files.map((file) => reachable(file, constants.X_OK)));
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

/**
 * The outermost app bundle or node_modules `file` sits in, where a program loads the rest of
 * itself and its dependencies from, or null when it sits in neither.
 */
const bundleOf = (file: string): string | null => {
  const parts = file.split(path.sep);
  const at = parts.findIndex((part) => part === "node_modules" || part.endsWith(".app"));
  return at === -1 ? null : parts.slice(0, at + 1).join(path.sep);
};

/**
 * The Homebrew prefix `file` sits in, when it sits in a keg or a cask: `opt/` links, libraries,
 * site-packages and config span the whole prefix, and a keg's programs load any of it.
 */
const homebrewOf = (file: string): string | null => {
  const parts = file.split(path.sep);
  const at = parts.findIndex((part) => part === "Cellar" || part === "Caskroom");
  return at <= 1 ? null : parts.slice(0, at).join(path.sep);
};

/** What a program on PATH at `file` runs from: its Homebrew prefix, else its bundle, else its own folder. */
const programTree = (file: string): string =>
  homebrewOf(file) ?? bundleOf(file) ?? path.dirname(file);

/** Whether `at` is `home` or a folder above it. */
const atOrAbove = (at: string, home: string): boolean =>
  path.relative(at, home).split(path.sep)[0] !== "..";

/**
 * What IdleBiz's own program at `file` runs from: the bundle it sits in, else, in dev, the whole
 * checkout: the workspace root, whose every package is built into main and whose scripts rebuild
 * and relaunch it, else the outermost folder short of home with a package.json.
 */
const appTree =
  (home: string) =>
  async (file: string): Promise<string> => {
    const bundle = bundleOf(file);
    if (bundle !== null) {
      return bundle;
    }
    const above: string[] = [];
    for (let dir = path.dirname(file); !atOrAbove(dir, home); dir = path.dirname(dir)) {
      above.push(dir);
    }
    const holding = (name: string): Promise<boolean[]> =>
      Promise.all(above.map((dir) => reachable(path.join(dir, name))));
    const [workspaceRoots, packages] = await Promise.all([
      holding("pnpm-workspace.yaml"),
      holding("package.json"),
    ]);
    return (
      above.find((_dir, at) => workspaceRoots[at] === true) ??
      above.findLast((_dir, at) => packages[at] === true) ??
      path.dirname(file)
    );
  };

/**
 * Each program at `files`: every folder its symlinks pass through, and the tree it lands in.
 * Never `home` or above, which would keep a run from its own login: there, only the path itself.
 */
const treesOf = async (
  home: string,
  files: readonly string[],
  treeOf: (file: string) => string | Promise<string>,
): Promise<string[]> => {
  const shortOfHome = (folder: string, at: string): string[] => {
    if (!atOrAbove(folder, home)) {
      return [folder];
    }
    return atOrAbove(at, home) ? [] : [at];
  };
  const trees = await Promise.all(
    files.map(async (file) => {
      const chain = await linkChain(file);
      const lands = await realPathOf(chain.at(-1) ?? file);
      return [
        ...chain.flatMap((at) => shortOfHome(path.dirname(at), at)),
        ...shortOfHome(await treeOf(lands), lands),
      ];
    }),
  );
  return trees.flat();
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

/** Whether one of `subpaths` above `at` already reaches it. */
const reachedFrom = (subpaths: ReadonlySet<string>, at: string): boolean => {
  const up = path.dirname(at);
  return up !== at && (subpaths.has(up) || reachedFrom(subpaths, up));
};

/** `reaches` once each, less any a subpath among them already reaches: the profile stays small. */
const outermost = (reaches: readonly Reach[]): Reach[] => {
  const subpaths = new Set(
    reaches.filter(({ match }) => match === "subpath").map(({ path: at }) => at),
  );
  const kept = new Map(
    reaches
      .filter(({ path: at }) => !reachedFrom(subpaths, at))
      .map((reach) => [`${reach.match} ${reach.path}`, reach]),
  );
  return [...kept.values()];
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

/** Every name in `home` starting with `login`, and where any of them leads. */
const loginOf = async (home: string, login: string): Promise<Reach[]> => {
  const prefix = path.join(home, login);
  const names = await readdir(home).catch(() => []);
  const reaches = await Promise.all(
    names.filter((name) => name.startsWith(login)).map((name) => reachOf(path.join(home, name))),
  );
  return [
    { match: "prefix", path: prefix },
    ...reaches.flat().filter(({ path: at }) => !at.startsWith(prefix)),
  ];
};

/** The seal of a run under `home`, resolved as it stands on disk now. */
export const sealFor = async ({
  clis,
  home,
  mainOnly,
  pathDirs,
  programs,
  save,
  sshAgent,
  writable,
}: {
  home: string;
  /** What only main touches, with every name that starts with it: main writes a file through `<file>.tmp`. */
  mainOnly: readonly string[];
  /** The founder's ssh agent, when main's env names one. */
  sshAgent: string | null;
  /** The save, which a run writes only inside `writable`. */
  save: string;
  /** Main's PATH, the login shell's folders on it whether they exist yet or not, each symlink in one followed. */
  pathDirs: readonly string[];
  /** The runner CLIs as main names them, a command on PATH or a path, which the founder runs unsealed. */
  clis: readonly string[];
  /** IdleBiz's own executable and main's own code, which the founder relaunches unsealed. */
  programs: readonly string[];
  /** The run's own folders, each in the save. */
  writable: readonly string[];
}): Promise<Seal> => {
  const realHome = await realPathOf(home);
  const under = (names: readonly string[]): Promise<Reach[]> =>
    reachesOf(names.map((name) => path.join(realHome, name)));
  // a relative folder names no fixed place to seal
  const onPath = [...new Set(pathDirs.filter((dir) => path.isAbsolute(dir)))];
  const found = await Promise.all(clis.map((cli) => foundOn(cli, onPath)));
  const onPathRuns = [...new Set([...found.flat(), ...(await linksIn(onPath))])];
  const trees = [
    ...(await treesOf(realHome, onPathRuns, programTree)),
    ...(await treesOf(realHome, programs, appTree(realHome))),
  ];
  return {
    agents: [
      ...(await under(AGENT_SOCKETS)),
      ...(sshAgent === null ? [] : await reachOf(sshAgent)),
    ],
    guarded: outermost(await reachesOf([...new Set([save, ...onPath, ...trees])])),
    otherLogin: {
      claude: await loginOf(realHome, RUNNER_SEALS.claude.otherLogin),
      codex: await loginOf(realHome, RUNNER_SEALS.codex.otherLogin),
    },
    unreadable: [...(await under(LOGINS)), ...(await reachesOf(mainOnly, "prefix"))],
    unwritable: await under(RUN_LATER),
    writable: await ownFolders(save, writable),
  };
};

/**
 * The seal of a run that writes `writable`, resolved as this machine stands now: its home, main's
 * PATH, the CLIs on it and IdleBiz itself. Each run resolves its own: a login that turns into a
 * symlink after boot is sealed where it leads from the next run on.
 */
export const machineSeal = (writable: readonly string[]): Promise<Seal> => {
  const agent = process.env.SSH_AUTH_SOCK;
  return sealFor({
    clis: RUNNER_IDS.map(runnerBin),
    home: homedir(),
    mainOnly: [SECRETS_PATH, PUSH_STAGING_DIR],
    pathDirs: (process.env.PATH ?? "").split(path.delimiter),
    programs: [process.execPath, import.meta.filename],
    save: ROOT_DIR,
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
        skipped: [...report.skipped, { error: refusal, kind: "seal", path: SANDBOX_EXEC }],
      };
