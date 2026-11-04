// The packaged app booted on a scratch save, on a macOS arm64 host with a display:
// docs/packaging.md says what it checks.
//
// `pnpm -F @repo/desktop smoke <path/to/IdleBiz.app>` smokes another .app, a release's from its dmg.

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { HANDOFF_PARAM } from "@repo/contract/routes";

const packageRoot = path.resolve(import.meta.dirname, "..");
const cliRoot = path.resolve(packageRoot, "..", "cli");
const [named] = process.argv.slice(2);
const appDir =
  named === undefined
    ? path.join(packageRoot, "src-tauri", "target", "release", "bundle", "macos", "IdleBiz.app")
    : path.resolve(named);
const shellBinary = path.join(appDir, "Contents", "MacOS", "IdleBiz");
// where src-tauri/src/runtime.rs finds them: node beside the shell, the server a resource
const bundledNode = path.join(appDir, "Contents", "MacOS", "node");
const serverDir = path.join(appDir, "Contents", "Resources", "server");
const noticesDir = path.join(appDir, "Contents", "Resources", "notices");
// what scripts/package.ts maps there: the Rust crates' licences, and node's with its source
const NOTICES = ["rust-crates.txt", "node/LICENSE", "node/SOURCE"];

// the shell's lines (src-tauri/src): the window's first load (window.rs), a launch it gave up on
// (lib.rs, shell.rs), and main's end (main_process.rs)
const WINDOW_LOADED = "[shell] window loaded";
const GAVE_UP = [
  "[shell] IdleBiz failed to start",
  "[shell] IdleBiz couldn't start",
  "[shell] IdleBiz stopped",
];
const MAIN_EXITED_CLEANLY = "main exited (code 0)";

// tauri-plugin-single-instance's machine-wide socket (`/tmp/<identifier>_si.sock`): an IdleBiz that
// answers on it would take this launch over, and the smoke would watch the wrong app
const SINGLE_INSTANCE_SOCKET = "/tmp/com_idlebiz_desktop_si.sock";
// the item the shell reads the key that seals secrets.json from, or makes on a first launch
// (src-tauri/src/keychain.rs)
const KEYCHAIN_SERVICE = "IdleBiz";
const KEYCHAIN_ACCOUNT = "sealing-key";
const KEYCHAIN_ITEM = ["-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT];
// `security`'s exit when no item matches
const NO_SUCH_ITEM = 44;
// a delete the Keychain holds on a prompt nobody answers
const KEYCHAIN_TIMEOUT_MS = 10_000;

// a cold WebKit, main's boot (its save claim, store, control plane and page server) and the
// handoff, on a CI runner
const BOOT_TIMEOUT_MS = 120_000;
// past a quit's 45s and main's 5s to exit once its stdin closes (main_process.rs)
const EXIT_TIMEOUT_MS = 60_000;
const HANDOVER_TIMEOUT_MS = 30_000;
// a login probe main was still waiting on when it quit outlives it, and ends on its own within the
// 15s main gives one (packages/agent-driver/src/detect.ts)
const PROBE_GRACE_MS = 15_000;

// what the packaged shell gives main in place of launchd's (src-tauri/src/runtime.rs `main_env`)
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
// the account's, wherever launchd's HOME points (src-tauri/src/shell.rs `logs_dir`)
const MAIN_LOG = path.join(userInfo().homedir, "Library", "Logs", "IdleBiz", "main.log");
// the names main's login-shell probe, its runners and its git would look up on a PATH
const PATH_CANARIES = ["bash", "claude", "codex", "git", "zsh"];

type Shell = ChildProcessByStdio<null, Readable, Readable>;

interface Launched {
  shell: Shell;
  /** Everything the shell has printed so far, main's stderr among it. */
  output: () => string;
}

interface Process {
  pid: number;
  pgid: number;
  ppid: number;
  args: string;
}

const log = (line: string): void => {
  process.stdout.write(`smoke: ${line}\n`);
};

const PS_LINE = /^\s*(?<pid>\d+)\s+(?<pgid>\d+)\s+(?<ppid>\d+)\s+(?<args>.*)$/u;

const processes = (): Process[] => {
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
const runsBundledNode = (running: Process): boolean => running.args.startsWith(`${bundledNode} `);

const loopbackPorts = (pid: number): number[] => {
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

const ended = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

/** Whether `child` exited within `ms`. */
const exitsWithin = async (child: ChildProcess, ms: number): Promise<boolean> => {
  if (ended(child)) {
    return true;
  }
  return await Promise.race([
    once(child, "exit").then(() => true),
    delay(ms, false, { ref: false }),
  ]);
};

const how = (child: ChildProcess): string =>
  child.exitCode === null ? String(child.signalCode) : `code ${child.exitCode}`;

const killGroup = (pgid: number): void => {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
};

/**
 * Deletes the key a launch made on a Mac whose Keychain held none: it sealed only the scratch save,
 * and kept, it would stop the next smoke here and meet the first IdleBiz installed after with a
 * prompt, being this ad-hoc pack's.
 */
const forgetKey = (): void => {
  const deleted = spawnSync("security", ["delete-generic-password", ...KEYCHAIN_ITEM], {
    stdio: "ignore",
    timeout: KEYCHAIN_TIMEOUT_MS,
  });
  if (deleted.status === 0) {
    log("deleted the key the launch made, leaving the Keychain as the smoke found it");
  } else if (deleted.status !== NO_SUCH_ITEM) {
    process.exitCode = 1;
    process.stderr.write(
      `smoke: the Keychain kept the key the launch made (security exited ${deleted.status ?? deleted.signal}): delete "${KEYCHAIN_SERVICE}" in Keychain Access before the next smoke\n`,
    );
  }
};

const answers = async (socket: string): Promise<boolean> => {
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

const launch = (args: readonly string[], env: NodeJS.ProcessEnv): Launched => {
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
const waitForLine = async (launched: Launched, line: string): Promise<void> => {
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
const mainOf = (shell: Shell): Process => {
  const children = processes().filter((running) => running.ppid === shell.pid);
  const mains = children.filter(runsBundledNode);
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
const startingEnvOf = (main: Process): Map<string, string> => {
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

/**
 * Main started on who the founder is and the save the launch named, whatever the env the app was
 * opened with said, and on none of what only launchd could have set there.
 */
const proveEnv = (main: Process, expected: Record<string, string>, dropped: string[]): void => {
  const env = startingEnvOf(main);
  const wrong = Object.entries(expected).flatMap(([name, value]) =>
    env.get(name) === value ? [] : [`${name}=${env.get(name) ?? "(unset)"}, not ${value}`],
  );
  const kept = [...env.keys()].filter(
    (name) => dropped.includes(name) || name.startsWith("NODE_") || name.startsWith("OPENSSL_"),
  );
  if (wrong.length > 0 || kept.length > 0) {
    throw new Error(
      `main started on launchd's word:\n  ${[...wrong, ...kept.map((name) => `${name} kept`)].join("\n  ")}`,
    );
  }
  log(`main started as the account, on the save its --root= named, without launchd's switches`);
};

/** The loopback port main answers the window's page on. */
const pagePortOf = async (main: Process): Promise<number> => {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    const [port, ...others] = loopbackPorts(main.pid);
    if (port !== undefined && others.length === 0) {
      return port;
    }
    if (Date.now() > deadline) {
      throw new Error(`main listens on ${others.length + 1} loopback ports, not its page's alone`);
    }
    await delay(250);
  }
};

/**
 * Main answers its page as it answers the window: a request with no handoff's cookie gets the
 * signed-out page, a handoff link it never minted signs nothing in, and the page's own files are the
 * pack's (apps/cli/src/server/page-server.ts).
 */
const provePage = async (port: number): Promise<void> => {
  const origin = `http://127.0.0.1:${port}`;
  const unsigned = await fetch(`${origin}/`, { redirect: "manual" });
  const document = await unsigned.text();
  if (unsigned.status !== 401 || !document.includes("<title>IdleBiz</title>")) {
    throw new Error(`main's page answered a request with no session ${unsigned.status}`);
  }
  const forged = await fetch(`${origin}/?${HANDOFF_PARAM}=never-minted`, { redirect: "manual" });
  if (
    forged.status !== 303 ||
    forged.headers.get("location") !== `${origin}/` ||
    forged.headers.has("set-cookie")
  ) {
    throw new Error(`main's page answered a handoff it never minted ${forged.status}`);
  }
  const page = readFileSync(path.join(serverDir, "dist", "page", "index.html"), "utf-8");
  const script = /src="(?<src>\/assets\/[^"]+\.js)"/u.exec(page)?.groups?.src;
  if (script === undefined) {
    throw new Error("the pack's page names no script of its own");
  }
  const served = await fetch(`${origin}${script}`);
  if (!served.ok || served.headers.get("content-type")?.startsWith("text/javascript") !== true) {
    throw new Error(`main did not serve the pack's ${script} (${served.status})`);
  }
  log(`main answers its page on ${origin}: signed out without a handoff, its files the pack's`);
};

if (!existsSync(shellBinary)) {
  throw new Error(`no packaged app at ${appDir}: run \`pnpm smoke:desktop\`, which packs it first`);
}
for (const binary of [shellBinary, bundledNode]) {
  try {
    accessSync(binary, constants.X_OK);
  } catch (error) {
    throw new Error(`the pack's ${path.basename(binary)} is missing or not executable: ${binary}`, {
      cause: error,
    });
  }
}

// every file the checkout's server ships under resources/, as git tracks it: a stray .DS_Store is
// no part of the pack
const tracked = spawnSync("git", ["ls-files", "-z", "--", "resources"], {
  cwd: cliRoot,
  encoding: "utf-8",
});
if (tracked.status !== 0) {
  throw new Error(`git ls-files exited ${tracked.status ?? tracked.signal}: ${tracked.stderr}`);
}
const resources = tracked.stdout.split("\0").filter((name) => name !== "");
const missing = [
  ...resources.filter((name) => !existsSync(path.join(serverDir, name))),
  ...NOTICES.filter((name) => !existsSync(path.join(noticesDir, name))).map(
    (name) => `notices/${name}`,
  ),
];
if (resources.length === 0 || missing.length > 0) {
  throw new Error(
    `the pack is missing what the server reads once a company runs, or the licences:\n  ${missing.join("\n  ")}`,
  );
}
log(`the pack carries the server's ${resources.length} resources and the licences`);

if (await answers(SINGLE_INSTANCE_SOCKET)) {
  throw new Error(
    "an IdleBiz is running on this Mac, which this launch would hand over to: quit it",
  );
}
// held, the key is an installed IdleBiz's, and an ad-hoc pack is not the app that made it: its read
// would wait on a Keychain prompt nobody answers. Absent, the launch makes one, as a first launch
// does, which the smoke deletes as it ends (`forgetKey`)
const keyHeld =
  spawnSync("security", ["find-generic-password", ...KEYCHAIN_ITEM], { stdio: "ignore" }).status ===
  0;
if (keyHeld) {
  throw new Error(
    `the Keychain holds IdleBiz's key ("${KEYCHAIN_SERVICE}", "${KEYCHAIN_ACCOUNT}"), which this pack would wait on a prompt to read: smoke on a Mac without it, as CI's`,
  );
}

const scratch = await mkdtemp(path.join(tmpdir(), "idlebiz-desktop-smoke-"));
const save = path.join(scratch, "save");
await mkdir(save);
// the packaged app takes its save from this argument alone (src-tauri/src/runtime.rs `root_arg`)
const args = [`--root=${save}`];

// each a script that leaves a file of its name here when anything runs it
const canaries = path.join(scratch, "canaries");
await mkdir(canaries);
const canary = async (file: string): Promise<void> => {
  await writeFile(file, `#!/bin/sh\n: > '${path.join(canaries, path.basename(file))}'\n`, {
    mode: 0o755,
  });
};
const decoy = path.join(scratch, "decoy");
const bin = path.join(scratch, "bin");
const zdot = path.join(scratch, "zdot");
await mkdir(bin);
await mkdir(zdot);
await mkdir(path.join(scratch, "fake-tmp"));
for (const name of [...PATH_CANARIES, "fake-shell", "fake-claude"]) {
  await canary(name.startsWith("fake-") ? path.join(scratch, name) : path.join(bin, name));
}
await writeFile(path.join(zdot, ".zshenv"), `: > '${path.join(canaries, "zshenv")}'\n`);
// a config node fails to start on, were it read
await writeFile(path.join(scratch, "x.cnf"), "openssl_conf = missing\n[missing\n");
await writeFile(path.join(scratch, "ca.pem"), "not a certificate\n");

// what a `launchctl setenv` could hand every app opened after it: another save, shell, temp
// folder, PATH and runner, a loader, test money counted, and startup files for main's login-shell
// probe. HOME is left alone, for the shell's own Keychain read may follow it; main's is the
// account's either way, which the env check below holds
const dropped = {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
  CLAUDE_BIN: path.join(scratch, "fake-claude"),
  CODEX_HOME: path.join(scratch, "codex"),
  IDLEBIZ_COUNT_TEST_MONEY: "1",
  OPENSSL_CONF: path.join(scratch, "x.cnf"),
  SSL_CERT_FILE: path.join(scratch, "ca.pem"),
};
const env = {
  ...process.env,
  ...dropped,
  IDLEBIZ_ROOT_DIR: decoy,
  PATH: `${bin}:${process.env.PATH ?? SYSTEM_PATH}`,
  SHELL: path.join(scratch, "fake-shell"),
  TMPDIR: path.join(scratch, "fake-tmp"),
  ZDOTDIR: zdot,
};
const account = userInfo();
const userTemp = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf-8" });
if (userTemp.status !== 0) {
  throw new Error(`getconf exited ${userTemp.status ?? userTemp.signal}: ${userTemp.stderr}`);
}
const expected = {
  HOME: account.homedir,
  IDLEBIZ_ROOT_DIR: save,
  LOGNAME: account.username,
  PATH: SYSTEM_PATH,
  SHELL: account.shell ?? "",
  TMPDIR: userTemp.stdout.trim(),
  USER: account.username,
};

const launched: Launched[] = [];
let main: Process | null = null;

try {
  log(`launching ${appDir} on ${save}, under an env a run could have set`);
  const launchedAt = Date.now();
  const first = launch(args, env);
  launched.push(first);
  // the shell makes the window only once main answered hello, on the handoff main then mints
  await waitForLine(first, WINDOW_LOADED);
  main = mainOf(first.shell);
  log(`hello booted main (pid ${main.pid}) on the pack's node, and the window loaded its page`);
  proveEnv(main, expected, Object.keys(dropped));
  if (!existsSync(MAIN_LOG) || statSync(MAIN_LOG).mtimeMs < launchedAt) {
    throw new Error(`the shell wrote no main.log under the account's home, ${MAIN_LOG}`);
  }
  await provePage(await pagePortOf(main));

  // the plugin hands a second launch's arguments to the first, which shows its window, and exits
  const second = launch(args, env);
  launched.push(second);
  if (!(await exitsWithin(second.shell, HANDOVER_TIMEOUT_MS))) {
    throw new Error(`a second launch was still running after ${HANDOVER_TIMEOUT_MS}ms`);
  }
  if (second.shell.exitCode !== 0) {
    throw new Error(`a second launch exited ${how(second.shell)}, not handing over`);
  }
  const nodes = processes().filter(runsBundledNode);
  if (ended(first.shell) || nodes.length !== 1 || nodes[0]?.pid !== main.pid) {
    throw new Error(`after a second launch ${nodes.length} mains run, not the first's alone`);
  }
  log("a second launch handed over to the first and started no main of its own");

  // SIGTERM quits as Quit does (lib.rs): main stops its runs and answers, then exits
  if (first.shell.pid === undefined) {
    throw new Error("the shell has no pid");
  }
  process.kill(first.shell.pid, "SIGTERM");
  if (!(await exitsWithin(first.shell, EXIT_TIMEOUT_MS))) {
    throw new Error(`the app was still running ${EXIT_TIMEOUT_MS}ms after SIGTERM`);
  }
  if (first.shell.exitCode !== 0) {
    throw new Error(`the app exited ${how(first.shell)} on SIGTERM, not 0`);
  }
  if (!first.output().includes(MAIN_EXITED_CLEANLY)) {
    throw new Error("the app quit without main exiting cleanly");
  }
  const { pgid } = main;
  const leftBehind = (): Process[] =>
    processes().filter((running) => running.pgid === pgid || runsBundledNode(running));
  const graceEnds = Date.now() + PROBE_GRACE_MS;
  let left = leftBehind();
  while (left.length > 0 && Date.now() < graceEnds) {
    await delay(250);
    left = leftBehind();
  }
  if (left.length > 0) {
    throw new Error(
      `the quit left what main started running:\n  ${left.map((running) => `${running.pid} ${running.args}`).join("\n  ")}`,
    );
  }
  log("the quit stopped main cleanly, the app exited 0, and nothing main started is left");

  // all main started has ended, its login-shell probe among it
  const followed = [...readdirSync(canaries), ...(existsSync(decoy) ? ["the decoy save"] : [])];
  if (followed.length > 0) {
    throw new Error(`the launch followed what launchd's env named: ${followed.join(", ")}`);
  }
  log(
    "nothing ran the env's shell, startup files, CLIs or PATH, and the decoy save was never made",
  );
  log("PASS (the window's rendering is not checked)");
} finally {
  for (const { shell } of launched) {
    if (shell.pid !== undefined && !ended(shell)) {
      killGroup(shell.pid);
    }
  }
  // main leads a group of its own, which the shell's death does not reach
  const mainGroup = main?.pgid;
  if (mainGroup !== undefined && processes().some((running) => running.pgid === mainGroup)) {
    killGroup(mainGroup);
  }
  forgetKey();
  await rm(scratch, { force: true, recursive: true });
}
