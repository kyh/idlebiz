import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { parseJson } from "@repo/domain/json";
import {
  KEYCHAIN_SERVICE,
  KEYCHAIN_TIMEOUT_MS,
  MAIN_EXITED_CLEANLY,
  SINGLE_INSTANCE_SOCKET,
  SYSTEM_PATH,
  VAULT_READ,
  WINDOW_LOADED,
  answers,
  ended,
  holdsVaultItem,
  how,
  isRunning,
  killGroup,
  launch,
  mainOf,
  mainUnder,
  mainsOf,
  packagedApp,
  processes,
  runsBundledNode,
  startingEnvOf,
  systemTempDir,
  waitForLine,
} from "./packaged-app.ts";
import type { Process } from "./packaged-app.ts";
import {
  axReady,
  clickTrayItem,
  describeWindows,
  dialogText,
  dismissDialog,
  securityPromptShown,
  trayItems,
} from "./tray-ax.ts";
import { openSigningKeychain, signAs } from "./test-identity.ts";
import type { SigningKeychain } from "./test-identity.ts";
import { openScratchKeychain, refuseKilledSmokesKeychain } from "./update-keychain.ts";
import type { ScratchKeychain } from "./update-keychain.ts";
import {
  APP_UPDATE_FILE,
  FEED_NAME,
  feedOfAppUpdate,
  loopbackFeed,
  offeredIn,
  updateTestSpecSchema,
  zipName,
} from "./update-test-pack.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const cliRoot = path.resolve(packageRoot, "..", "cli");
const REPORT_DIR = path.join(packageRoot, ".output", "smoke-update");
const FEED_LOG = path.join(REPORT_DIR, "feed.log");

const OPEN_ITEM = "Open Acme";
const UPDATE_ITEM = "Update to IdleBiz ";
const NOT_DOWNLOADED = "could not be downloaded";
const VAULT_REFUSED = "[shell] the Keychain would not";
const MAIN_LOG = path.join(homedir(), "Library", "Logs", "IdleBiz", "main.log");

const SHIPIT_LOG = path.join(
  homedir(),
  "Library",
  "Caches",
  "com.idlebiz.desktop.ShipIt",
  "ShipIt_stderr.log",
);

const CHECK_TIMEOUT_MS = 60_000;
const TRAY_TIMEOUT_MS = 60_000;
const TRAY_SETTLE_MS = 5000;
const BOX_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 180_000;
const RELAUNCH_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 60_000;
const PROBE_GRACE_MS = 15_000;
const POLL_MS = 500;
const TRAY_POLL_MS = 3000;
const PROMPT_POLL_MS = 3000;

const log = (line: string) => {
  process.stdout.write(`update smoke: ${line}\n`);
};

const run = (
  what: string,
  file: string,
  argv: readonly string[],
  options: SpawnSyncOptions = {},
) => {
  const ran = spawnSync(file, argv, { stdio: "inherit", ...options });

  if (ran.status !== 0) {
    throw new Error(`could not ${what}: ${file} exited ${ran.status ?? ran.signal}`);
  }
};

const waitFor = async <T>(
  look: () => T | null,
  ms: number,
  failure: () => string,
  every = POLL_MS,
) => {
  const deadline = Date.now() + ms;

  for (;;) {
    const found = look();

    if (found !== null) {
      return found;
    }

    if (Date.now() > deadline) {
      throw new Error(failure());
    }

    await delay(every);
  }
};

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

const bundleVersion = (app: string) => {
  const read = spawnSync(
    "/usr/bin/plutil",
    [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      path.join(app, "Contents", "Info.plist"),
    ],
    { encoding: "utf-8" },
  );

  if (read.status !== 0) {
    throw new Error(`plutil could not read the version of ${app}: ${read.stderr.trim()}`);
  }

  return read.stdout.trim();
};

const versionSchema = z.object({ version: z.string() });

const readJson = <T>(file: string, schema: z.ZodType<T>) =>
  schema.parse(parseJson(readFileSync(file, "utf-8")));

const serverVersion = (app: string) =>
  readJson(path.join(app, "Contents", "Resources", "server", "package.json"), versionSchema)
    .version;

const semver = (version: string) => {
  const parts = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u.exec(version)?.groups;

  if (parts?.major === undefined || parts.minor === undefined || parts.patch === undefined) {
    throw new Error(`${version} is no version such as 0.0.11`);
  }

  return [Number(parts.major), Number(parts.minor), Number(parts.patch)] satisfies [
    number,
    number,
    number,
  ];
};

const newer = (one: string, other: string) => {
  const [a, b] = [semver(one), semver(other)];

  for (const at of [0, 1, 2] as const) {
    if (a[at] !== b[at]) {
      return a[at] > b[at];
    }
  }

  return false;
};

const OWN_MOVES = new Set([".main", path.join("company", "state")]);

interface Snapshot {
  files: Map<string, string>;
  logs: Map<string, Buffer>;
}

const snapshotOf = (root: string) => {
  const snapshot: Snapshot = { files: new Map(), logs: new Map() };

  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      const file = path.join(root, name);

      if (OWN_MOVES.has(name)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(name);
      } else if (!entry.isFile()) {
        snapshot.files.set(name, "(neither a file nor a folder)");
      } else if (name.endsWith(".jsonl")) {
        snapshot.logs.set(name, readFileSync(file));
      } else {
        snapshot.files.set(name, sha256(file));
      }
    }
  };

  walk("");

  return snapshot;
};

const changesBetween = (before: Snapshot, after: Snapshot) => [
  ...[...before.files].flatMap(([name, hash]) => {
    const now = after.files.get(name);

    if (now === undefined) {
      return [`${name} is gone`];
    }

    return now === hash ? [] : [`${name} changed`];
  }),
  ...[...after.files.keys()].flatMap((name) => (before.files.has(name) ? [] : [`${name} is new`])),
  ...[...before.logs].flatMap(([name, bytes]) => {
    const now = after.logs.get(name);

    if (now === undefined) {
      return [`${name} is gone`];
    }

    return now.subarray(0, bytes.length).equals(bytes)
      ? []
      : [`${name} was rewritten, not appended to`];
  }),
  ...[...after.logs.keys()].flatMap((name) => (before.logs.has(name) ? [] : [`${name} is new`])),
];

const sizeOf = (file: string) => (existsSync(file) ? statSync(file).size : 0);

const tailOf = (file: string, from: number) =>
  existsSync(file) ? readFileSync(file).subarray(from).toString("utf-8") : "";

const sha512Of = (file: string) => createHash("sha512").update(readFileSync(file)).digest("base64");

const zipped = (app: string, zip: string) => {
  run(`zip ${app}`, "ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
};

const args = process.argv.slice(2);
const packsArg = args.find((arg) => arg.startsWith("--packs="));
const unknown = args.filter((arg) => arg !== packsArg);

if (unknown.length > 0) {
  throw new Error(`the update smoke takes --packs=<dir> alone, not ${unknown.join(" ")}`);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("the update smoke runs on an Apple-silicon Mac: its packs are arm64 .apps");
}

if (process.env.IDLEBIZ_PACK_UPDATE_TEST !== undefined) {
  throw new Error(
    "IDLEBIZ_PACK_UPDATE_TEST is set, but the smoke names each of its packs' specs itself: unset it",
  );
}

if (!axReady()) {
  throw new Error(
    "System Events does not answer UI scripting here, and the update begins from IdleBiz's menu-bar item: let this terminal control the computer (System Settings, Privacy & Security, Accessibility)",
  );
}

const refuseRunningIdleBiz = async () => {
  if (await answers(SINGLE_INSTANCE_SOCKET)) {
    throw new Error(
      "an IdleBiz is running on this Mac, which a launch would hand over to and whose menu-bar item would read as the smoke's: quit it",
    );
  }
};

await refuseRunningIdleBiz();

refuseKilledSmokesKeychain();

if (holdsVaultItem()) {
  throw new Error(
    `the Keychain holds IdleBiz's keys ("${KEYCHAIN_SERVICE}"), which are no smoke's to sit beside or to delete: smoke on a Mac without them, as CI's`,
  );
}

const packsOf = (dir: string) => {
  const updateDir = path.join(dir, "update");

  return {
    feed: path.join(updateDir, FEED_NAME),
    installed: path.join(dir, "installed", "IdleBiz.app"),
    update: path.join(updateDir, "IdleBiz.app"),
    updateDir,
  };
};

const keptPacks = packsArg === undefined ? null : path.resolve(packsArg.slice("--packs=".length));
const kept = keptPacks === null ? null : packsOf(keptPacks);
const keptFiles = kept === null ? [] : [kept.installed, kept.update, kept.feed];
const reuse = keptFiles.length > 0 && keptFiles.every((file) => existsSync(file));

if (!reuse && keptFiles.some((file) => existsSync(file))) {
  throw new Error(
    `${keptPacks ?? ""} holds part of a pair of packs: remove it, and the smoke packs both again`,
  );
}

const reusedPort =
  reuse && kept !== null
    ? Number(
        new URL(
          feedOfAppUpdate(
            readFileSync(
              path.join(kept.installed, "Contents", "Resources", APP_UPDATE_FILE),
              "utf-8",
            ),
          ),
        ).port,
      )
    : 0;

const scratch = realpathSync.native(
  await mkdtemp(path.join(systemTempDir(), "idlebiz-update-smoke-")),
);

const {
  feed: packedFeed,
  installed: installedPack,
  update: updatePack,
  updateDir,
} = kept ?? packsOf(path.join(scratch, "packs"));

const packs = path.dirname(updateDir);

const save = path.join(packs, "save");
const install = path.join(scratch, "Applications", "IdleBiz.app");
const installed = packagedApp(install);
const PROXIES = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]);

const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !PROXIES.has(name.toUpperCase())),
  ),
  PATH: SYSTEM_PATH,
};

interface Served {
  body: Buffer | null;
  archive: string | null;
}

const requests: string[] = [];
const feed: Served = { archive: null, body: null };

await mkdir(REPORT_DIR, { recursive: true });

writeFileSync(FEED_LOG, "");

const NO_CACHE = /^\?noCache=[0-9a-v]+$/u;

const pathOf = (url: string) => {
  const parsed = new URL(url, "http://127.0.0.1");

  return parsed.search === "" || NO_CACHE.test(parsed.search) ? parsed.pathname : url;
};

const answer = (request: IncomingMessage, response: ServerResponse) => {
  const asked = `${request.method ?? "?"} ${pathOf(request.url ?? "?")}`;

  const heard = (status: number) => {
    requests.push(asked);
    appendFileSync(FEED_LOG, `${new Date().toISOString()} ${asked} ${status}\n`);
    log(`the feed answered ${asked} ${status}`);
  };

  if (asked === `GET /${FEED_NAME}` && feed.body !== null) {
    response.writeHead(200, { "content-type": "text/yaml" });
    response.end(feed.body);
    heard(200);

    return;
  }

  if (feed.archive !== null && asked === `GET /${path.basename(feed.archive)}`) {
    response.writeHead(200, {
      "content-length": statSync(feed.archive).size,
      "content-type": "application/zip",
    });
    createReadStream(feed.archive)
      .on("error", () => response.destroy())
      .pipe(response);
    heard(200);

    return;
  }

  response.writeHead(404).end();
  heard(404);
};

const server = createServer(answer);

let keychain: ScratchKeychain | null = null;
let signing: SigningKeychain | null = null;
let shellGroup: number | null = null;
const mainGroups: number[] = [];
let cleaned = false;

const leftUndone = (what: string) => {
  process.exitCode = 1;
  process.stderr.write(`update smoke: ${what}\n`);
};

const step = (what: string, undo: () => void) => {
  try {
    undo();
  } catch (error) {
    leftUndone(`could not ${what}: ${String(error)}`);
  }
};

const cleanUp = () => {
  if (cleaned) {
    return;
  }

  cleaned = true;
  step("stop what the app started", () => {
    const running = processes();

    for (const group of [shellGroup, ...mainGroups]) {
      if (group !== null && running.some((each) => each.pgid === group)) {
        killGroup(group);
      }
    }
  });
  const opened = keychain;

  if (opened !== null) {
    step("look for a key a launch wrote", () => {
      if (!holdsVaultItem(opened.found)) {
        return;
      }

      const deleted = spawnSync(
        "security",
        ["delete-generic-password", "-s", KEYCHAIN_SERVICE, ...opened.found],
        { stdio: "ignore", timeout: KEYCHAIN_TIMEOUT_MS },
      );

      leftUndone(
        deleted.status === 0
          ? "a launch wrote a key to the user's Keychain, entering none, which the smoke deleted"
          : `a launch wrote a key to the user's Keychain, entering none, which the smoke could not delete: delete "${KEYCHAIN_SERVICE}" in Keychain Access`,
      );
    });
    step("put the Keychain back", () => {
      for (const failure of opened.restore()) {
        leftUndone(failure);
      }
    });
  }

  const signer = signing;

  if (signer !== null) {
    step("put the signing keychain away", () => {
      for (const failure of signer.close()) {
        leftUndone(failure);
      }
    });
  }

  step("close the feed", () => {
    server.closeAllConnections();
    server.close();
  });
  step(`remove ${scratch}`, () => {
    rmSync(scratch, { force: true, recursive: true });
    rmSync(save, { force: true, recursive: true });
  });
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    cleanUp();
    process.kill(process.pid, signal);
  });
}

process.once("exit", cleanUp);

try {
  try {
    server.listen(reusedPort, "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    throw new Error(
      reuse
        ? `the feed could not take 127.0.0.1:${reusedPort}, the port the packs in ${packs} ask: free it, or remove ${packs} and the smoke packs both again`
        : "the feed could not listen on loopback",
      { cause: error },
    );
  }

  const listening = z.object({ port: z.number() }).safeParse(server.address());

  if (!listening.success) {
    throw new Error("the feed listens on no TCP port");
  }

  const feedUrl = `http://127.0.0.1:${listening.data.port}/${FEED_NAME}`;
  log(`the feed answers ${feedUrl}, and logs each request to ${FEED_LOG}`);

  const identities = await mkdtemp(path.join(scratch, "identities-"));
  signing = openSigningKeychain(identities);
  const identityB = signing.identity("IdleBiz Update Smoke B");

  if (reuse) {
    log(`reusing the packs in ${packs}, which ask ${feedUrl}`);
  } else {
    const identityA = signing.identity("IdleBiz Update Smoke A");
    const { version } = readJson(path.join(packageRoot, "package.json"), versionSchema);
    const [major, minor, patch] = semver(version);

    const pack = (name: string, spec: z.input<typeof updateTestSpecSchema>) => {
      const file = path.join(scratch, `${name}.spec.json`);
      writeFileSync(file, `${JSON.stringify(updateTestSpecSchema.parse(spec), null, 2)}\n`);
      log(`packing ${name}: ${file}`);
      run(
        `pack ${name} (see package.ts's output above)`,
        process.execPath,
        ["scripts/package.ts"],
        {
          cwd: packageRoot,
          env: { ...process.env, IDLEBIZ_PACK_UPDATE_TEST: file },
        },
      );
    };

    const signedBy = { feed: feedUrl, identity: identityA, keychain: signing.file, root: save };

    pack("installed", {
      archive: false,
      outDir: path.dirname(installedPack),
      version,
      ...signedBy,
    });
    pack("update", {
      archive: true,
      outDir: updateDir,
      version: `${major}.${minor}.${patch + 1}`,
      ...signedBy,
    });
  }

  const from = bundleVersion(installedPack);
  const offered = offeredIn(readFileSync(packedFeed, "utf-8"));
  const to = offered.version;

  if (bundleVersion(updatePack) !== to || !newer(to, from)) {
    throw new Error(
      `the packs are ${from} and ${bundleVersion(updatePack)}, offered as ${to}: the update is the newer, and its feed names it`,
    );
  }

  if (offered.path !== zipName(to)) {
    throw new Error(`the update's feed names ${offered.path}, not its zip, ${zipName(to)}`);
  }

  log(`IdleBiz ${from} is to update to ${to}`);

  await mkdir(path.dirname(install));
  run("install the pack", "ditto", [installedPack, install]);
  log(`installed IdleBiz ${from} at ${install}`);

  run(
    "seed the save (see vitest's output above)",
    "pnpm",
    ["exec", "vitest", "run", "--config", "vitest.seed.config.ts"],
    {
      cwd: cliRoot,
      env: { ...process.env, IDLEBIZ_SEED_ROOT: save, TMPDIR: systemTempDir() },
    },
  );
  log(`seeded Acme on ${save}`);

  const badApp = path.join(scratch, "bad", "IdleBiz.app");
  await mkdir(path.dirname(badApp));
  run("copy the update", "ditto", [updatePack, badApp]);
  signAs(badApp, identityB, signing.file);
  const badZip = path.join(scratch, "bad", zipName(to));
  zipped(badApp, badZip);
  log(`re-signed a copy of the update as ${identityB}, an identity neither pack is`);

  for (const failure of signing.close()) {
    leftUndone(failure);
  }

  signing = null;

  keychain = openScratchKeychain(scratch, [install, updatePack]);
  log(`${keychain.file} holds a key of IdleBiz's for both packs, first on the search list`);

  const goodZip = path.join(updateDir, zipName(to));
  const goodFeed = await readFile(packedFeed);

  const badFeed = Buffer.from(
    loopbackFeed({
      feed: feedUrl,
      releasedAt: new Date(),
      sha512: sha512Of(badZip),
      size: statSync(badZip).size,
      version: to,
    }),
  );

  const offer = (zip: string, body: Buffer) => {
    feed.archive = zip;
    feed.body = body;
  };

  offer(goodZip, goodFeed);

  let promptLookedAt = 0;

  const refusal = () => {
    const mains = mainsOf(installed);

    if (mains.length > 1) {
      return `${mains.length} mains serve the save at once:\n  ${mains.map((each) => `${each.pid} ${each.args}`).join("\n  ")}`;
    }

    if (Date.now() - promptLookedAt < PROMPT_POLL_MS) {
      return null;
    }

    promptLookedAt = Date.now();

    try {
      return securityPromptShown()
        ? "macOS asks for leave in a SecurityAgent window nobody here answers: the Keychain's, when the scratch keychain's partition list did not let this pack read its key (update-keychain.ts), or an administrator's, when ShipIt was refused the install's folder"
        : null;
    } catch (error) {
      log(`could not look for a Keychain prompt: ${String(error)}`);

      return null;
    }
  };

  const rootOf = (main: Process) => {
    const root = startingEnvOf(main).get("IDLEBIZ_ROOT_DIR");

    if (root !== save) {
      throw new Error(`main ${main.pid} serves ${root ?? "no save"}, not the test pack's, ${save}`);
    }
  };

  const proveVaultRead = (output: string, version: string) => {
    if (output.includes(VAULT_REFUSED)) {
      throw new Error(
        `IdleBiz ${version} was refused its keys: ${output.slice(output.indexOf(VAULT_REFUSED)).split("\n")[0] ?? ""}`,
      );
    }

    if (!output.includes(`${VAULT_READ}1 of its keys`)) {
      throw new Error(`IdleBiz ${version} did not read the scratch keychain's key at hello`);
    }

    if (keychain !== null && holdsVaultItem(keychain.found)) {
      throw new Error(`IdleBiz ${version} wrote a key to the user's Keychain, entering none`);
    }
  };

  let lookFailed: string | null = null;

  const look = <T>(read: () => T) => {
    try {
      const seen = read();
      lookFailed = null;

      return seen;
    } catch (error) {
      lookFailed = error instanceof Error ? error.message : String(error);

      return null;
    }
  };

  const lastFailure = () => (lookFailed === null ? "" : `\nits last look failed: ${lookFailed}`);

  let lastTray: string[] = [];

  const waitForTray = (wanted: (items: string[]) => boolean, what: string) =>
    waitFor(
      () => {
        lastTray = look(trayItems) ?? lastTray;

        return lookFailed === null && wanted(lastTray) ? lastTray : null;
      },
      TRAY_TIMEOUT_MS,
      () =>
        `IdleBiz's menu-bar item did not ${what} within ${TRAY_TIMEOUT_MS}ms (a notification the shell is still posting holds main's redraws behind it, main-process.ts); it showed:\n  ${lastTray.join("\n  ")}${lastFailure()}`,
      TRAY_POLL_MS,
    );

  const offeredItem = `${UPDATE_ITEM}${to}…`;

  await refuseRunningIdleBiz();
  log(`launching IdleBiz ${from} on ${save}, on the system PATH`);
  const first = launch(installed, [`--root=${save}`], env);

  if (first.shell.pid === undefined) {
    throw new Error("the shell has no pid");
  }

  const shellPid = first.shell.pid;
  shellGroup = shellPid;
  await waitForLine(first, WINDOW_LOADED, { refusal });
  const firstMain = mainOf(installed, first.shell);
  mainGroups.push(firstMain.pgid);
  rootOf(firstMain);
  log(`IdleBiz ${from} booted main (pid ${firstMain.pid}) on the save --root= named`);
  await waitFor(
    () => requests.includes(`GET /${FEED_NAME}`) || null,
    CHECK_TIMEOUT_MS,
    () =>
      `IdleBiz ${from} asked ${feedUrl} nothing within ${CHECK_TIMEOUT_MS}ms: main's boot check never reached the feed`,
  );
  proveVaultRead(first.output(), from);
  log(`IdleBiz ${from} read the scratch keychain's key with no prompt`);
  await waitForTray(
    (items) => items.includes(OPEN_ITEM) && items.includes(offeredItem),
    `show "${OPEN_ITEM}" and "${offeredItem}"`,
  );
  log(`the menu-bar item opens Acme and offers "${offeredItem}"`);
  const before = snapshotOf(save);

  offer(badZip, badFeed);
  let asked = requests.length;
  let said = first.output().length;
  clickTrayItem(UPDATE_ITEM);
  log(`clicked "${offeredItem}", the feed offering a zip signed as ${identityB}`);

  const box = await waitFor(
    () => {
      const text = look(dialogText);

      return text === "" ? null : text;
    },
    BOX_TIMEOUT_MS,
    () =>
      `IdleBiz showed no box within ${BOX_TIMEOUT_MS}ms of a click on "${offeredItem}" with a zip by another identity on offer${lastFailure()}\nits windows then:\n${describeWindows()}`,
  );

  if (!box.includes(NOT_DOWNLOADED)) {
    throw new Error(`the box another identity's zip should open says something else:\n${box}`);
  }

  if (!requests.slice(asked).includes(`GET /${zipName(to)}`)) {
    throw new Error(
      `IdleBiz said ${to} ${NOT_DOWNLOADED} without asking the feed for its zip:\n${box}`,
    );
  }

  log(
    `IdleBiz downloaded the zip, Squirrel refused its signature, and it said so in a box:\n${box}`,
  );
  dismissDialog();
  await waitFor(
    () => (look(dialogText) === "" ? true : null),
    BOX_TIMEOUT_MS,
    () =>
      `IdleBiz's box stayed open after its OK was clicked${lastFailure()}\nits windows then:\n${describeWindows()}`,
  );

  if (first.output().slice(said).includes("main exited")) {
    throw new Error("main exited over an update whose signature Squirrel refused");
  }

  if (mainOf(installed, first.shell).pid !== firstMain.pid || ended(first.shell)) {
    throw new Error("a refused release replaced main or the shell, which run on as they were");
  }

  if (bundleVersion(install) !== from) {
    throw new Error(
      `a refused release left IdleBiz ${bundleVersion(install)} installed, not ${from}`,
    );
  }

  log(`main ${firstMain.pid} runs on, and IdleBiz ${from} is still the one installed`);
  await waitForTray((items) => items.includes(offeredItem), `offer "${offeredItem}" again`);
  log(`main asked the feed again and offers "${offeredItem}" again`);

  offer(goodZip, goodFeed);
  asked = requests.length;
  said = first.output().length;
  clickTrayItem(UPDATE_ITEM);
  log(`clicked "${offeredItem}", the feed offering the update as packed`);
  await waitForLine(first, MAIN_EXITED_CLEANLY, { after: said, refusal });

  if (!requests.slice(asked).includes(`GET /${zipName(to)}`)) {
    throw new Error("main stopped for an update the shell never downloaded");
  }

  log(
    "the shell downloaded the update, Squirrel checked its signature, and main stopped as Quit does",
  );
  const loggedBefore = sizeOf(MAIN_LOG);
  const shipItBefore = sizeOf(SHIPIT_LOG);
  const askedByNext = requests.length;
  await waitFor(
    () => {
      const failed = first
        .output()
        .slice(said)
        .split("\n")
        .find((line) => line.includes("[shell] could not install IdleBiz"));

      if (failed !== undefined) {
        throw new Error(`the update did not install: ${failed}`);
      }

      const refused = refusal();

      if (refused !== null) {
        throw new Error(refused);
      }

      return ended(first.shell) || null;
    },
    INSTALL_TIMEOUT_MS,
    () =>
      `IdleBiz ${from} was still running ${INSTALL_TIMEOUT_MS}ms after main stopped: the install or its restart hung\nShipIt said:\n${tailOf(SHIPIT_LOG, shipItBefore)}`,
  );

  if (first.shell.exitCode !== 0) {
    throw new Error(`IdleBiz ${from} exited ${how(first.shell)}, not 0 as a restart does`);
  }

  const relaunched = await waitFor(
    () =>
      processes().find((each) => each.args === installed.shellBinary && each.pid !== shellPid) ??
      null,
    RELAUNCH_TIMEOUT_MS,
    () =>
      `no shell ran \`${installed.shellBinary}\` within ${RELAUNCH_TIMEOUT_MS}ms of IdleBiz ${from} exiting: ShipIt did not relaunch the app\nShipIt said:\n${tailOf(SHIPIT_LOG, shipItBefore)}`,
  );

  log(
    `IdleBiz ${from} exited 0, and ShipIt relaunched it as pid ${relaunched.pid}, with no arguments`,
  );
  const relaunchedLog = { output: () => tailOf(MAIN_LOG, loggedBefore), shell: first.shell };
  await waitForLine(relaunchedLog, WINDOW_LOADED, { refusal, restartedAs: relaunched.pid });
  const nextMain = mainUnder(installed, relaunched.pid);
  mainGroups.push(nextMain.pgid);
  const mains = mainsOf(installed);

  if (nextMain.pid === firstMain.pid || mains.length !== 1) {
    throw new Error(
      `the relaunch serves the save on ${mains.length} mains, not one new one:\n  ${mains.map((each) => `${each.pid} ${each.args}`).join("\n  ")}`,
    );
  }

  rootOf(nextMain);
  log(
    `the relaunch booted one main (pid ${nextMain.pid}) on the save it carries, and its window loaded`,
  );

  const version = bundleVersion(install);

  if (version !== to) {
    throw new Error(`the relaunched app's Info.plist reads ${version}, not ${to}`);
  }

  const shellSha = sha256(installed.shellBinary);

  if (
    shellSha !== sha256(packagedApp(updatePack).shellBinary) ||
    shellSha === sha256(packagedApp(installedPack).shellBinary)
  ) {
    throw new Error(`the installed shell is not the update's ${to}, byte for byte`);
  }

  if (serverVersion(install) !== to) {
    throw new Error(`the installed server names ${serverVersion(install)}, not ${to}`);
  }

  const verified = spawnSync("codesign", ["--verify", "--deep", "--strict", install], {
    encoding: "utf-8",
  });

  if (verified.status !== 0) {
    throw new Error(`the installed app's signature does not hold: ${verified.stderr.trim()}`);
  }

  log(
    `IdleBiz ${to} is installed whole: its Info.plist, shell, server and signature are the update's`,
  );
  await waitFor(
    () => requests.slice(askedByNext).includes(`GET /${FEED_NAME}`) || null,
    CHECK_TIMEOUT_MS,
    () => `IdleBiz ${to} asked ${feedUrl} nothing within ${CHECK_TIMEOUT_MS}ms of its relaunch`,
  );
  await delay(TRAY_SETTLE_MS);
  const items = await waitForTray((shown) => shown.includes(OPEN_ITEM), `show "${OPEN_ITEM}"`);
  const stillOffered = items.find((item) => item.startsWith(UPDATE_ITEM));

  if (stillOffered !== undefined) {
    throw new Error(
      `IdleBiz ${to} still offers "${stillOffered}": its check did not find it current`,
    );
  }

  log(`IdleBiz ${to}'s menu opens Acme and offers no update: its check found it current`);
  const changes = changesBetween(before, snapshotOf(save));

  if (changes.length > 0) {
    throw new Error(`the update moved the save:\n  ${changes.join("\n  ")}`);
  }

  proveVaultRead(relaunchedLog.output(), to);
  log(
    `the save is as IdleBiz ${from} left it, and ${to} reads the same Keychain key with no prompt`,
  );

  const loggedBeforeQuit = sizeOf(MAIN_LOG);
  process.kill(relaunched.pid, "SIGTERM");
  await waitFor(
    () => (isRunning(relaunched.pid) ? null : true),
    EXIT_TIMEOUT_MS,
    () => `IdleBiz ${to} was still running ${EXIT_TIMEOUT_MS}ms after SIGTERM`,
  );

  if (!tailOf(MAIN_LOG, loggedBeforeQuit).includes(MAIN_EXITED_CLEANLY)) {
    throw new Error(`IdleBiz ${to} quit without main exiting cleanly`);
  }

  const groups = new Set([shellPid, relaunched.pgid, firstMain.pgid, nextMain.pgid]);
  let left: Process[] = [];
  await waitFor(
    () => {
      left = processes().filter(
        (each) => groups.has(each.pgid) || runsBundledNode(installed, each),
      );

      return left.length === 0 ? true : null;
    },
    PROBE_GRACE_MS,
    () =>
      `the quit left what the app or main started running:\n  ${left.map((each) => `${each.pid} ${each.args}`).join("\n  ")}`,
  );
  log(`IdleBiz ${to} quit cleanly, and left nothing it started running`);
  log("PASS");
} finally {
  cleanUp();
}
