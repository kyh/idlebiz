import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

/** The server's own entry, its bundle, and what the shell asks of it. */
export const SERVE_ENTRY = "dist/index.js";

export const SERVE_ARGS = ["serve"] as const;

interface Runtime {
  node: string;
  cliDir: string;
}

/**
 * The packaged app carries node beside its own binary and the server as a resource; a development
 * shell runs the checkout's built server on the terminal's node. Nothing in the environment can
 * point the shell elsewhere.
 */
export const resolveRuntime = (where: {
  packaged: boolean;
  appPath: string;
  execPath: string;
  resourcesPath: string;
}) => {
  if (!where.packaged) {
    return {
      cliDir: path.resolve(where.appPath, "..", "cli"),
      node: "node",
    } satisfies Runtime;
  }

  const runtime: Runtime = {
    cliDir: path.join(where.resourcesPath, "server"),
    node: path.join(path.dirname(where.execPath), "node"),
  };

  const required = [
    runtime.node,
    path.join(runtime.cliDir, SERVE_ENTRY),
    path.join(runtime.cliDir, "dist", "page", "index.html"),
    path.join(runtime.cliDir, "resources", "skills"),
  ];

  const missing = required.find((file) => !existsSync(file));

  if (missing !== undefined) {
    throw new Error(`this install is incomplete: ${missing} is missing. Reinstall IdleBiz.`);
  }

  return runtime;
};

const NODE_LOADERS = ["NODE_", "OPENSSL_"] as const;

const DEVELOPER_ONLY = new Set([
  "IDLEBIZ_ROOT_DIR",
  "IDLEBIZ_COUNT_TEST_MONEY",
  "IDLEBIZ_STAND_IN",
  "CLAUDE_BIN",
  "CODEX_BIN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
]);

const RUNNER_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "AZURE_OPENAI_"] as const;

/** macOS's own PATH, as launchd sets it by default: folders SIP keeps and no run writes. */
export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

interface Account {
  name: string;
  home: string;
  shell: string;
  temp: string | null;
}

/** A packaged launch: who the founder is, and the save `--root=` names. */
export interface Packaged {
  account: Account;
  root: string | null;
}

/**
 * The account as the user database has it, never as launchd's env says: `os.userInfo()` reads the
 * password database, and the temp folder is macOS's, asked with an empty env.
 */
export const accountOf = (
  user: { username: string; homedir: string; shell: string | null },
  temp: string | null,
) => {
  if (!path.isAbsolute(user.homedir)) {
    throw new Error(`macOS gives your account no home folder: it says "${user.homedir}"`);
  }

  if (user.shell === null || user.shell === "") {
    throw new Error("macOS gives your account no login shell");
  }

  return {
    home: user.homedir,
    name: user.username,
    shell: user.shell,
    temp: temp !== null && path.isAbsolute(temp) ? temp : null,
  } satisfies Account;
};

/**
 * The save the shell's arguments name, `--root=<dir>`: one token, which launchd cannot set and no
 * run can pass. A restart keeps it.
 */
export const rootArg = (args: readonly string[]) => {
  const root = args.find((arg) => arg.startsWith("--root="))?.slice("--root=".length);

  return root === undefined || root === "" ? null : root;
};

const launchdOnly = (name: string) =>
  DEVELOPER_ONLY.has(name) ||
  (name.endsWith("BASE_URL") && RUNNER_PREFIXES.some((prefix) => name.startsWith(prefix))) ||
  name.startsWith("SSL_CERT_") ||
  name.includes("CA_BUNDLE") ||
  name.includes("CA_CERT") ||
  name === "TMPDIR" ||
  name === "TMP" ||
  name === "TEMP";

/**
 * What main starts from: the shell's environment less what node loads, as the dev host gives it.
 * A packaged launch's env is launchd's, so main takes none of what only launchd could have set
 * there, and takes who the founder is from the system.
 */
export const mainEnv = (inherited: NodeJS.ProcessEnv, packaged: Packaged | null) => {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(inherited)) {
    const dropped =
      NODE_LOADERS.some((prefix) => name.startsWith(prefix)) ||
      (packaged !== null && launchdOnly(name));

    if (value !== undefined && !dropped) {
      env[name] = value;
    }
  }

  if (packaged === null) {
    return env;
  }

  const { account, root } = packaged;
  env.HOME = account.home;
  env.SHELL = account.shell;
  env.USER = account.name;
  env.LOGNAME = account.name;
  env.PATH = SYSTEM_PATH;

  if (account.temp !== null) {
    env.TMPDIR = account.temp;
  }

  if (root !== null) {
    env.IDLEBIZ_ROOT_DIR = root;
  }

  return env;
};

/** The save main opens, as `apps/cli/src/server/paths.ts` resolves it. */
export const rootDir = (home: string, override: string | null, cwd: string) =>
  override === null ? path.join(home, ".idlebiz") : path.resolve(cwd, override);

/**
 * Where main's log goes: `~/Library/Logs/IdleBiz` for the app, where Console lists a Mac app's
 * logs; a development shell keeps its own beside its data, one folder per isolated save.
 */
export const logsDir = (packaged: boolean, home: string, appData: string, root: string) => {
  if (packaged) {
    return path.join(home, "Library", "Logs", "IdleBiz");
  }

  const dev = path.join(appData, "IdleBiz (dev)");

  if (root === path.join(home, ".idlebiz")) {
    return path.join(dev, "logs");
  }

  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);

  return path.join(dev, "roots", id, "logs");
};
