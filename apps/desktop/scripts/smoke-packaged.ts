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
const NOTICES = ["rust-crates.txt", "node/LICENSE", "node/SOURCE"];

const EXIT_TIMEOUT_MS = 60_000;
const HANDOVER_TIMEOUT_MS = 30_000;
const PROBE_GRACE_MS = 15_000;

const MAIN_LOG = path.join(userInfo().homedir, "Library", "Logs", "IdleBiz", "main.log");
const PATH_CANARIES = ["bash", "claude", "codex", "git", "zsh"];

const log = (line: string) => {
  process.stdout.write(`smoke: ${line}\n`);
};

const forgetKeys = () => {
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

const proveEnv = (main: Process, expected: Record<string, string>, dropped: string[]) => {
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

const pagePortOf = async (main: Process) => {
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

const provePage = async (port: number) => {
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
  ...NOTICES.flatMap((name) =>
    existsSync(path.join(noticesDir, name)) ? [] : [`notices/${name}`],
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

if (holdsVaultItem()) {
  throw new Error(
    `the Keychain holds IdleBiz's keys ("${KEYCHAIN_SERVICE}"), which this pack would wait on a prompt to read: smoke on a Mac without them, as CI's`,
  );
}

const scratch = await mkdtemp(path.join(tmpdir(), "idlebiz-desktop-smoke-"));
const save = path.join(scratch, "save");

await mkdir(save);

const args = [`--root=${save}`];

const canaries = path.join(scratch, "canaries");

await mkdir(canaries);

const canary = async (file: string) => {
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

await writeFile(path.join(scratch, "x.cnf"), "openssl_conf = missing\n[missing\n");

await writeFile(path.join(scratch, "ca.pem"), "not a certificate\n");

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

  const leftBehind = () =>
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

  const mainGroup = main?.pgid;

  if (mainGroup !== undefined && processes().some((running) => running.pgid === mainGroup)) {
    killGroup(mainGroup);
  }

  forgetKeys();
  await rm(scratch, { force: true, recursive: true });
}
