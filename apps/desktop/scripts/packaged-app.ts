// The packaged app as a smoke drives it, on a macOS host: where the .app keeps the shell, main's
// node and the server, the shell launched and read as it prints, the processes it and main run, as
// `ps` lists them, and the Keychain item it seals secrets.json with.

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

/** An .app's files, where src-tauri/src/runtime.rs finds them. */
interface PackagedApp {
  shellBinary: string;
  /** Main's node, beside the shell. */
  bundledNode: string;
  /** The server, a resource. */
  serverDir: string;
  noticesDir: string;
}

export const packagedApp = (appDir: string): PackagedApp => ({
  bundledNode: path.join(appDir, "Contents", "MacOS", "node"),
  noticesDir: path.join(appDir, "Contents", "Resources", "notices"),
  serverDir: path.join(appDir, "Contents", "Resources", "server"),
  shellBinary: path.join(appDir, "Contents", "MacOS", "IdleBiz"),
});

// the shell's lines (src-tauri/src): the window's first load (window.rs), a launch it gave up on
// (lib.rs, shell.rs), an update it downloaded but could not install (updater.rs), and main's end
// (main_process.rs)
export const WINDOW_LOADED = "[shell] window loaded";
const GAVE_UP = [
  "[shell] IdleBiz failed to start",
  "[shell] IdleBiz couldn't start",
  "[shell] IdleBiz stopped",
  "[shell] could not install IdleBiz",
];
export const MAIN_EXITED_CLEANLY = "main exited (code 0)";

// what the packaged shell gives main in place of launchd's (src-tauri/src/runtime.rs `main_env`),
// and the PATH a launch's shell finds macOS's own `touch` first on, which an update runs
// (src-tauri/src/updater.rs)
export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// the item the shell reads the key that seals secrets.json from, or makes on a first launch
// (src-tauri/src/keychain.rs)
export const KEYCHAIN_SERVICE = "IdleBiz";
export const KEYCHAIN_ACCOUNT = "sealing-key";
export const KEYCHAIN_ITEM = ["-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT] as const;
// `security`'s exit when no item matches
export const NO_SUCH_ITEM = 44;
// a Keychain call held on a prompt nobody answers
export const KEYCHAIN_TIMEOUT_MS = 10_000;

/** Whether `keychains`, or the user's search list without any, hold IdleBiz's sealing key. */
export const holdsSealingKey = (keychains: readonly string[] = []): boolean => {
  const found = spawnSync("security", ["find-generic-password", ...KEYCHAIN_ITEM, ...keychains], {
    stdio: "ignore",
    timeout: KEYCHAIN_TIMEOUT_MS,
  });
  if (found.status !== 0 && found.status !== NO_SUCH_ITEM) {
    throw new Error(
      `security could not say whether the Keychain holds IdleBiz's key (it exited ${found.status ?? found.signal})`,
    );
  }
  return found.status === 0;
};

// tauri-plugin-single-instance's machine-wide socket (`/tmp/<identifier>_si.sock`): an IdleBiz that
// answers on it would take this launch over, and the smoke would watch the wrong app
export const SINGLE_INSTANCE_SOCKET = "/tmp/com_idlebiz_desktop_si.sock";

// a cold WebKit, main's boot (its save claim, store, control plane and page server) and the
// handoff, on a CI runner
export const BOOT_TIMEOUT_MS = 120_000;

type Shell = ChildProcessByStdio<null, Readable, Readable>;

export interface Launched {
  shell: Shell;
  /** Everything the shell has printed so far, main's stderr among it. */
  output: () => string;
}

export interface Process {
  pid: number;
  pgid: number;
  ppid: number;
  args: string;
}

const PS_LINE = /^\s*(?<pid>\d+)\s+(?<pgid>\d+)\s+(?<ppid>\d+)\s+(?<args>.*)$/u;

export const processes = (): Process[] => {
  const listed = spawnSync("ps", ["-A", "-ww", "-o", "pid=,pgid=,ppid=,args="], {
    encoding: "utf-8",
  });
  if (listed.status !== 0) {
    throw new Error(`ps exited ${listed.status ?? listed.signal}: ${listed.stderr}`);
  }
  return listed.stdout.split("\n").flatMap((line) => {
    const groups = PS_LINE.exec(line)?.groups;
    const { pid, pgid, ppid, args } = { ...groups };
    if (pid === undefined || pgid === undefined || ppid === undefined || args === undefined) {
      return [];
    }
    return [{ args, pgid: Number(pgid), pid: Number(pid), ppid: Number(ppid) }];
  });
};

// the shell names main's node beside the path its own binary was started by, which is this one
export const runsBundledNode = ({ bundledNode }: PackagedApp, running: Process): boolean =>
  running.args.startsWith(`${bundledNode} `);

export const loopbackPorts = (pid: number): number[] => {
  const listed = spawnSync(
    "lsof",
    ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
    { encoding: "utf-8" },
  );
  return listed.stdout.split("\n").flatMap((line) => {
    const port = /^n127\.0\.0\.1:(?<port>\d+)$/u.exec(line)?.groups?.port;
    return port === undefined ? [] : [Number(port)];
  });
};

export const ended = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

/** Whether `pid` still runs: one the launched shell restarted as is no child of the smoke's. */
export const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Whether `child` exited within `ms`. */
export const exitsWithin = async (child: ChildProcess, ms: number): Promise<boolean> => {
  if (ended(child)) {
    return true;
  }
  return await Promise.race([
    once(child, "exit").then(() => true),
    delay(ms, false, { ref: false }),
  ]);
};

export const how = (child: ChildProcess): string =>
  child.exitCode === null ? String(child.signalCode) : `code ${child.exitCode}`;

export const killGroup = (pgid: number): void => {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    // a group already gone is fine; any other failure leaves processes running
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
};

export const answers = async (socket: string): Promise<boolean> => {
  const probe = createConnection(socket);
  try {
    await once(probe, "connect");
    return true;
  } catch {
    return false;
  } finally {
    probe.destroy();
  }
};

export const launch = (
  { shellBinary }: PackagedApp,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Launched => {
  // a process group of its own, so a failed smoke takes the shell down whole
  const shell = spawn(shellBinary, args, {
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const record = (chunk: Buffer): void => {
    output += chunk.toString();
    process.stdout.write(chunk);
  };
  shell.stdout.on("data", record);
  shell.stderr.on("data", record);
  return { output: () => output, shell };
};

interface Wait {
  /** Where in the output the line is looked for: one printed before it is another launch's. */
  after?: number;
  /** The shell that prints it, when the launched one restarted as it, as an update does. */
  restartedAs?: number;
  /** Asked as it waits, and failing it at once with what it says: a prompt the launch is held on. */
  refusal?: () => string | null;
}

/** Waits for the shell to print `line`, failing as soon as it gives up or exits. */
export const waitForLine = async (
  launched: Launched,
  line: string,
  { after = 0, restartedAs, refusal }: Wait = {},
): Promise<void> => {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  const exited = (): string | null => {
    if (restartedAs !== undefined) {
      return isRunning(restartedAs) ? null : `the shell it restarted as (pid ${restartedAs})`;
    }
    return ended(launched.shell) ? `the shell (${how(launched.shell)})` : null;
  };
  for (;;) {
    const output = launched.output().slice(after);
    if (output.includes(line)) {
      return;
    }
    const gaveUp = output.split("\n").find((said) => GAVE_UP.some((note) => said.includes(note)));
    if (gaveUp !== undefined) {
      throw new Error(`the shell gave up: ${gaveUp}`);
    }
    const gone = exited();
    if (gone !== null) {
      throw new Error(`${gone} exited before it printed "${line}"`);
    }
    const refused = refusal?.() ?? null;
    if (refused !== null) {
      throw new Error(refused);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the shell had not printed "${line}" within ${BOOT_TIMEOUT_MS}ms: see its output above`,
      );
    }
    await delay(250);
  }
};

/** Main: the one child of the shell `pid` on the node the pack carries. */
export const mainUnder = (app: PackagedApp, pid: number): Process => {
  const children = processes().filter((running) => running.ppid === pid);
  const mains = children.filter((running) => runsBundledNode(app, running));
  const [main] = mains;
  if (main === undefined || mains.length !== 1) {
    throw new Error(
      `the shell runs ${mains.length} children on the pack's node, not main alone:\n  ${children.map((running) => running.args).join("\n  ")}`,
    );
  }
  return main;
};

/** Main: the launched shell's one child on the node the pack carries. */
export const mainOf = (app: PackagedApp, shell: Shell): Process => {
  if (shell.pid === undefined) {
    throw new Error("the shell has no pid");
  }
  return mainUnder(app, shell.pid);
};

// a name opening an entry of `ps -E`'s env, which follows the command line, space-separated
const ENV_ENTRY = / (?=[A-Za-z_][A-Za-z0-9_]*=)/u;
// where main's command line ends: its bundle, asked to serve (src-tauri/src/runtime.rs)
const SERVE_COMMAND_END = "/dist/index.js serve ";

/** Every main the pack's node serves, whichever shell started it. */
export const mainsOf = (app: PackagedApp): Process[] =>
  processes().filter(
    (running) =>
      runsBundledNode(app, running) &&
      `${running.args} `.includes(`${app.serverDir}${SERVE_COMMAND_END}`),
  );

/** The env main started with, as `ps -E` shows it: each value runs to the next ` NAME=`. */
export const startingEnvOf = (main: Process): Map<string, string> => {
  const listed = spawnSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(main.pid)], {
    encoding: "utf-8",
  });
  if (listed.status !== 0) {
    throw new Error(`ps -E exited ${listed.status ?? listed.signal}: ${listed.stderr}`);
  }
  const line = listed.stdout.replace(/\n$/u, "");
  const end = line.indexOf(SERVE_COMMAND_END);
  if (end === -1) {
    throw new Error(`ps -E shows main as something other than its serve: ${line}`);
  }
  const env = new Map<string, string>();
  for (const entry of line.slice(end + SERVE_COMMAND_END.length).split(ENV_ENTRY)) {
    const at = entry.indexOf("=");
    const name = entry.slice(0, at);
    if (at > 0 && !env.has(name)) {
      env.set(name, entry.slice(at + 1));
    }
  }
  return env;
};
