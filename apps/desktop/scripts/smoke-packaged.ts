// The packaged app booted on a scratch save, on a macOS arm64 host with a display:
// docs/packaging.md says what it checks.
//
// `pnpm -F @repo/desktop smoke <path/to/IdleBiz.app>` smokes another .app, a release's from its dmg.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HANDOFF_PARAM } from "@repo/contract/routes";
import {
  BOOT_TIMEOUT_MS,
  KEYCHAIN_SERVICE,
  KEYCHAIN_TIMEOUT_MS,
  MAIN_EXITED_CLEANLY,
  SINGLE_INSTANCE_SOCKET,
  SYSTEM_PATH,
  WINDOW_LOADED,
  answers,
  ended,
  exitsWithin,
  VAULT_READ,
  holdsVaultItem,
  how,
  killGroup,
  launch,
  loopbackPorts,
  mainOf,
  packagedApp,
  processes,
  runsBundledNode,
  startingEnvOf,
  waitForLine,
} from "./packaged-app.ts";
import type { Launched, Process } from "./packaged-app.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const cliRoot = path.resolve(packageRoot, "..", "cli");
const [named] = process.argv.slice(2);
// a test pack leaves its .app in its spec's folder and never rebuilds the release target's, which
// the smoke would then boot stale
if (named === undefined && process.env.IDLEBIZ_PACK_UPDATE_TEST !== undefined) {
  throw new Error(
    "IDLEBIZ_PACK_UPDATE_TEST is set, so the pack before this smoke was a test pack, which leaves src-tauri/target/release's .app as it was: unset it, or name the .app to smoke",
  );
}
const appDir =
  named === undefined
    ? path.join(packageRoot, "src-tauri", "target", "release", "bundle", "macos", "IdleBiz.app")
    : path.resolve(named);
const app = packagedApp(appDir);
const { shellBinary, bundledNode, serverDir, noticesDir } = app;
// what scripts/package.ts maps there: the Rust crates' licences, and node's with its source
const NOTICES = ["rust-crates.txt", "node/LICENSE", "node/SOURCE"];

// past a quit's 45s and main's 5s to exit once its stdin closes (main_process.rs)
const EXIT_TIMEOUT_MS = 60_000;
const HANDOVER_TIMEOUT_MS = 30_000;
// a login probe main was still waiting on when it quit outlives it, and ends on its own within the
// 15s main gives one (packages/agent-driver/src/detect.ts)
const PROBE_GRACE_MS = 15_000;

// the account's, wherever launchd's HOME points (src-tauri/src/shell.rs `logs_dir`)
const MAIN_LOG = path.join(userInfo().homedir, "Library", "Logs", "IdleBiz", "main.log");
// the names main's login-shell probe, its runners and its git would look up on a PATH
const PATH_CANARIES = ["bash", "claude", "codex", "git", "zsh"];

const log = (line: string): void => {
  process.stdout.write(`smoke: ${line}\n`);
};

/**
 * Deletes any key a launch wrote, which none should, entering none: kept, it would stop the next
 * smoke here and meet the first IdleBiz installed after with a prompt, being this ad-hoc pack's.
 */
const forgetKeys = (): void => {
  if (!holdsVaultItem()) {
    return;
  }
  process.exitCode = 1;
  const deleted = spawnSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE], {
    stdio: "ignore",
    timeout: KEYCHAIN_TIMEOUT_MS,
  });
  process.stderr.write(
    deleted.status === 0 && !holdsVaultItem()
      ? "smoke: the launch wrote a key to the Keychain, entering none; the smoke deleted it\n"
      : `smoke: the launch wrote a key to the Keychain, entering none, which the smoke could not delete: delete "${KEYCHAIN_SERVICE}" in Keychain Access before the next smoke\n`,
  );
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
// held, a key is an installed IdleBiz's, and an ad-hoc pack is not the app that made it: its read
// would wait on a Keychain prompt nobody answers
if (holdsVaultItem()) {
  throw new Error(
    `the Keychain holds IdleBiz's keys ("${KEYCHAIN_SERVICE}"), which this pack would wait on a prompt to read: smoke on a Mac without them, as CI's`,
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
  const first = launch(app, args, env);
  launched.push(first);
  // the shell makes the window only once main answered hello, on the handoff main then mints
  await waitForLine(first, WINDOW_LOADED);
  if (!first.output().includes(`${VAULT_READ}0 of its keys`)) {
    throw new Error("the shell did not read the Keychain's empty vault at hello");
  }
  main = mainOf(app, first.shell);
  log(`hello booted main (pid ${main.pid}) on the pack's node, and the window loaded its page`);
  proveEnv(main, expected, Object.keys(dropped));
  if (!existsSync(MAIN_LOG) || statSync(MAIN_LOG).mtimeMs < launchedAt) {
    throw new Error(`the shell wrote no main.log under the account's home, ${MAIN_LOG}`);
  }
  await provePage(await pagePortOf(main));

  // the plugin hands a second launch's arguments to the first, which shows its window, and exits
  const second = launch(app, args, env);
  launched.push(second);
  if (!(await exitsWithin(second.shell, HANDOVER_TIMEOUT_MS))) {
    throw new Error(`a second launch was still running after ${HANDOVER_TIMEOUT_MS}ms`);
  }
  if (second.shell.exitCode !== 0) {
    throw new Error(`a second launch exited ${how(second.shell)}, not handing over`);
  }
  const nodes = processes().filter((running) => runsBundledNode(app, running));
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
    processes().filter((running) => running.pgid === pgid || runsBundledNode(app, running));
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
  forgetKeys();
  await rm(scratch, { force: true, recursive: true });
}
