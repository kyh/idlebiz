// The packaged app as a smoke drives it, on a macOS host: where the .app keeps the shell, main's
// node and the server, the shell launched and read as it prints, and the processes it and main
// run, as `ps` lists them.

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
// (lib.rs, shell.rs), and main's end (main_process.rs)
export const WINDOW_LOADED = "[shell] window loaded";
const GAVE_UP = [
  "[shell] IdleBiz failed to start",
  "[shell] IdleBiz couldn't start",
  "[shell] IdleBiz stopped",
];
export const MAIN_EXITED_CLEANLY = "main exited (code 0)";

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

/** Waits for the shell to print `line`, failing as soon as it gives up or exits. */
export const waitForLine = async (launched: Launched, line: string): Promise<void> => {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    const output = launched.output();
    if (output.includes(line)) {
      return;
    }
    const gaveUp = output.split("\n").find((said) => GAVE_UP.some((note) => said.includes(note)));
    if (gaveUp !== undefined) {
      throw new Error(`the shell gave up: ${gaveUp}`);
    }
    if (ended(launched.shell)) {
      throw new Error(`the shell exited (${how(launched.shell)}) before it printed "${line}"`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the shell had not printed "${line}" within ${BOOT_TIMEOUT_MS}ms: see its output above`,
      );
    }
    await delay(250);
  }
};

/** Main: the shell's one child on the node the pack carries. */
export const mainOf = (app: PackagedApp, shell: Shell): Process => {
  const children = processes().filter((running) => running.ppid === shell.pid);
  const mains = children.filter((running) => runsBundledNode(app, running));
  const [main] = mains;
  if (main === undefined || mains.length !== 1) {
    throw new Error(
      `the shell runs ${mains.length} children on the pack's node, not main alone:\n  ${children.map((running) => running.args).join("\n  ")}`,
    );
  }
  return main;
};

// a name opening an entry of `ps -E`'s env, which follows the command line, space-separated
const ENV_ENTRY = / (?=[A-Za-z_][A-Za-z0-9_]*=)/u;
// where main's command line ends: its bundle, asked to serve (src-tauri/src/runtime.rs)
const SERVE_COMMAND_END = "/dist/index.js serve ";

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
