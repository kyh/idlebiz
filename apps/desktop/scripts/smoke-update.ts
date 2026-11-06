// IdleBiz updating itself end to end, on an Apple-silicon Mac with a display and UI scripting: an
// installed test pack takes the next release from a feed on loopback under a throwaway key, begun
// from its own menu-bar item, and opens again on the save it had. docs/packaging.md says what it
// checks.
//
// `--packs=<dir>` packs into <dir>, in the OS's temporary folder, once, and reuses what it holds
// after, so a rerun packs nothing.

import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  constants,
  createReadStream,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { parseJson } from "@repo/domain/json";
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_ITEM,
  KEYCHAIN_SERVICE,
  KEYCHAIN_TIMEOUT_MS,
  MAIN_EXITED_CLEANLY,
  SINGLE_INSTANCE_SOCKET,
  SYSTEM_PATH,
  WINDOW_LOADED,
  answers,
  ended,
  holdsSealingKey,
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
import { FEED_NAME, archiveName } from "./release-feed.ts";
import {
  axReady,
  clickTrayItem,
  describeWindows,
  dialogText,
  dismissDialog,
  securityPromptShown,
  trayItems,
} from "./tray-ax.ts";
import { openScratchKeychain, refuseKilledSmokesKeychain } from "./update-keychain.ts";
import type { ScratchKeychain } from "./update-keychain.ts";
import { loopbackFeed, updateTestSpecSchema } from "./update-test-pack.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const cliRoot = path.resolve(packageRoot, "..", "cli");
// what a failed run leaves to be read, which CI uploads with main's log: every request the feed
// answered
const REPORT_DIR = path.join(packageRoot, ".output", "smoke-update");
const FEED_LOG = path.join(REPORT_DIR, "feed.log");

// the menu-bar item's labels (apps/cli/src/server/tray.ts): the seed's company is Acme
const OPEN_ITEM = "Open Acme";
const UPDATE_ITEM = "Update to IdleBiz ";
// the box a download main asked for and the shell refused says (apps/cli/src/server/updates.ts)
const NOT_DOWNLOADED = "could not be downloaded";
// what the shell and main say when the launch has no Keychain key (keychain.rs, serve.ts)
const NO_KEY = ["[shell] the Keychain would not", "the Keychain is unavailable"];
// the folders tauri-plugin-updater swaps the app through, on the app's volume: the shell's TMPDIR,
// or beside the app
const SWAP_FOLDER = /^tauri_(?:current|updated)_app/u;
// main's sealed value (apps/cli/src/server/secrets.ts): AES-256-GCM's nonce, ciphertext and tag,
// as base64, bound to the name it is kept under
const SEALED_V2 = "sealed:v2:";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

// main's check at boot, a moment after its window loads
const CHECK_TIMEOUT_MS = 60_000;
// main's menu redraws 1.5s after it moves, behind any notification the shell is still posting
const TRAY_TIMEOUT_MS = 60_000;
const TRAY_SETTLE_MS = 5000;
// a download over loopback, its signature checked, and main asking the feed again
const BOX_TIMEOUT_MS = 120_000;
// main stopped, the archive unpacked over the app, and the restart
const INSTALL_TIMEOUT_MS = 180_000;
const RELAUNCH_TIMEOUT_MS = 30_000;
// past a quit's 45s and main's 5s to exit once its stdin closes (main_process.rs)
const EXIT_TIMEOUT_MS = 60_000;
// a login probe main was still waiting on when it quit ends on its own within 15s
const PROBE_GRACE_MS = 15_000;
const POLL_MS = 500;
const TRAY_POLL_MS = 3000;
// how often a wait looks for a Keychain prompt: each look is an osascript
const PROMPT_POLL_MS = 3000;

const log = (line: string): void => {
  process.stdout.write(`update smoke: ${line}\n`);
};

const run = (
  what: string,
  file: string,
  argv: readonly string[],
  options: SpawnSyncOptions = {},
): void => {
  const ran = spawnSync(file, argv, { stdio: "inherit", ...options });
  if (ran.status !== 0) {
    throw new Error(`could not ${what}: ${file} exited ${ran.status ?? ran.signal}`);
  }
};

/** Waits for `look` to find something, failing with `failure`'s sentence once `ms` have passed. */
const waitFor = async <T>(
  look: () => T | null,
  ms: number,
  failure: () => string,
  every = POLL_MS,
): Promise<T> => {
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

const sha256 = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

/** An .app's version, as Finder and the updater's install read it. */
const bundleVersion = (app: string): string => {
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
/** A JSON file as `schema` reads it. */
const readJson = <T>(file: string, schema: z.ZodType<T>): T =>
  schema.parse(parseJson(readFileSync(file, "utf-8")));

/** The version the server an .app carries names (apps/cli/src/paths.ts). */
const serverVersion = (app: string): string =>
  readJson(path.join(app, "Contents", "Resources", "server", "package.json"), versionSchema)
    .version;

const semver = (version: string): [number, number, number] => {
  const parts = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u.exec(version)?.groups;
  if (parts?.major === undefined || parts.minor === undefined || parts.patch === undefined) {
    throw new Error(`${version} is no version such as 0.0.11`);
  }
  return [Number(parts.major), Number(parts.minor), Number(parts.patch)];
};

const newer = (one: string, other: string): boolean => {
  const [a, b] = [semver(one), semver(other)];
  for (const at of [0, 1, 2] as const) {
    if (a[at] !== b[at]) {
      return a[at] > b[at];
    }
  }
  return false;
};

// the feed a test pack that is the update writes beside its archive (update-test-pack.ts)
const feedSchema = z.object({
  platforms: z.object({ "darwin-aarch64": z.object({ signature: z.string(), url: z.string() }) }),
  version: z.string(),
});

// secrets.json as the seed writes it and main keeps it: each name's value, as text
const secretsSchema = z.record(z.string(), z.string());

/** What the save's secrets.json holds under `name`, as main wrote it. */
const storedSecret = (save: string, name: string): string => {
  const value = readJson(path.join(save, "secrets.json"), secretsSchema)[name];
  if (value === undefined) {
    throw new Error(`secrets.json holds no ${name} any more`);
  }
  return value;
};

/** A value main sealed, opened with `key`; null when it is not sealed, or sealed with another. */
const openSealed = (text: string, name: string, key: string): string | null => {
  if (!text.startsWith(SEALED_V2)) {
    return null;
  }
  const sealed = Buffer.from(text.slice(SEALED_V2.length), "base64");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "base64"),
      sealed.subarray(0, NONCE_BYTES),
      { authTagLength: TAG_BYTES },
    );
    decipher.setAAD(Buffer.from(name, "utf-8"));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf-8");
  } catch {
    return null;
  }
};

// what main moves on its own in a save it boots on, left out of the comparison: the claim each main
// makes on the save as it boots (apps/cli/src/server/save-claim.ts), and the running state main
// keeps for itself, rewritten as the founder looks away and the office moves, whose loss loses
// nothing canonical (apps/cli/src/server/paths.ts). Each *.jsonl is an append-only log
const OWN_MOVES = new Set([".main", path.join("company", "state")]);

interface Snapshot {
  /** Each file's sha-256, by its path in the save. */
  files: Map<string, string>;
  /** Each append-only log's bytes. */
  logs: Map<string, Buffer>;
}

const snapshotOf = (root: string): Snapshot => {
  const snapshot: Snapshot = { files: new Map(), logs: new Map() };
  const walk = (relative: string): void => {
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

/** What moved in the save between two snapshots, but for what main moves on its own. */
const changesBetween = (before: Snapshot, after: Snapshot): string[] => [
  ...[...before.files].flatMap(([name, hash]) => {
    const now = after.files.get(name);
    if (now === undefined) {
      return [`${name} is gone`];
    }
    return now === hash ? [] : [`${name} changed`];
  }),
  ...[...after.files.keys()]
    .filter((name) => !before.files.has(name))
    .map((name) => `${name} is new`),
  ...[...before.logs].flatMap(([name, bytes]) => {
    const now = after.logs.get(name);
    if (now === undefined) {
      return [`${name} is gone`];
    }
    return now.subarray(0, bytes.length).equals(bytes)
      ? []
      : [`${name} was rewritten, not appended to`];
  }),
  ...[...after.logs.keys()]
    .filter((name) => !before.logs.has(name))
    .map((name) => `${name} is new`),
];

/** Every swap folder of the updater's in the folders it makes them in. */
const swapFolders = (dirs: readonly string[]): string[] =>
  dirs.flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => SWAP_FOLDER.test(name))
          .map((name) => path.join(dir, name))
      : [],
  );

// ---- what the smoke refuses before it makes anything

const args = process.argv.slice(2);
const packsArg = args.find((arg) => arg.startsWith("--packs="));
const unknown = args.filter((arg) => arg !== packsArg);
if (unknown.length > 0) {
  throw new Error(`the update smoke takes --packs=<dir> alone, not ${unknown.join(" ")}`);
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(
    "the update smoke runs on an Apple-silicon Mac: its packs are arm64 .apps, and the feed offers darwin-aarch64 alone",
  );
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
/** Refuses an IdleBiz running on this Mac; asked again before the first launch, after the packs. */
const refuseRunningIdleBiz = async (): Promise<void> => {
  if (await answers(SINGLE_INSTANCE_SOCKET)) {
    throw new Error(
      "an IdleBiz is running on this Mac, which a launch would hand over to and whose menu-bar item would read as the smoke's: quit it",
    );
  }
};
await refuseRunningIdleBiz();
// a run killed outright left its keychain first on the list, whose key would read as the user's
refuseKilledSmokesKeychain();
if (holdsSealingKey()) {
  throw new Error(
    `the Keychain holds IdleBiz's key ("${KEYCHAIN_SERVICE}", "${KEYCHAIN_ACCOUNT}"), which is no smoke's to sit beside or to delete: smoke on a Mac without it, as CI's`,
  );
}

// where a pair of packs lies in its folder: the installed one's .app, and the update's beside its
// archive and its feed
const packsOf = (dir: string) => {
  const updateDir = path.join(dir, "update");
  return {
    feed: path.join(updateDir, FEED_NAME),
    installed: path.join(dir, "installed", "IdleBiz.app"),
    update: path.join(updateDir, "IdleBiz.app"),
    updateDir,
  };
};
// the packs are made afresh in scratch, unless --packs= names a folder that keeps them
const keptPacks = packsArg === undefined ? null : path.resolve(packsArg.slice("--packs=".length));
const kept = keptPacks === null ? null : packsOf(keptPacks);
const keptFiles = kept === null ? [] : [kept.installed, kept.update, kept.feed];
const reuse = keptFiles.length > 0 && keptFiles.every((file) => existsSync(file));
if (!reuse && keptFiles.some((file) => existsSync(file))) {
  throw new Error(
    `${keptPacks ?? ""} holds part of a pair of packs: remove it, and the smoke packs both again`,
  );
}
if (!reuse && process.env.IDLEBIZ_PACK_UNSIGNED !== "1") {
  throw new Error(
    "a test pack is ad-hoc, so it opens on this Mac alone: run with IDLEBIZ_PACK_UNSIGNED=1, as CI does",
  );
}
// kept packs ask the feed at the port they were packed with, which the feed takes again
const reusedPort =
  reuse && kept !== null
    ? Number(new URL(readJson(kept.feed, feedSchema).platforms["darwin-aarch64"].url).port)
    : 0;

// package.ts refuses a test pack outside the system's own temporary folder, whatever TMPDIR says
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

// ---- what the smoke undoes, in the order it does it, however it ends

const save = path.join(scratch, "save");
const install = path.join(scratch, "Applications", "IdleBiz.app");
const installed = packagedApp(install);
// main's runs read the env's proxies, but the feed is on loopback, where none may answer it
const PROXIES = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]);
// the shell's own PATH finds macOS's `touch` first, or an update is refused (updater.rs)
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !PROXIES.has(name.toUpperCase())),
  ),
  PATH: SYSTEM_PATH,
};
// a key in the shell's env would sign anything the smoke signs, and conflicts with the one it names
const signerEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("TAURI_SIGNING_")),
);
/** What the feed serves: a latest.json, and the archive it names. */
interface Served {
  body: Buffer | null;
  archive: string | null;
}
const requests: string[] = [];
const feed: Served = { archive: null, body: null };
await mkdir(REPORT_DIR, { recursive: true });
writeFileSync(FEED_LOG, "");

const answer = (request: IncomingMessage, response: ServerResponse): void => {
  const asked = `${request.method ?? "?"} ${request.url ?? "?"}`;
  const heard = (status: number): void => {
    requests.push(asked);
    appendFileSync(FEED_LOG, `${new Date().toISOString()} ${asked} ${status}\n`);
    log(`the feed answered ${asked} ${status}`);
  };
  if (request.method === "GET" && request.url === `/${FEED_NAME}` && feed.body !== null) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(feed.body);
    heard(200);
    return;
  }
  if (
    request.method === "GET" &&
    feed.archive !== null &&
    request.url === `/${path.basename(feed.archive)}`
  ) {
    response.writeHead(200, {
      "content-length": statSync(feed.archive).size,
      "content-type": "application/gzip",
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
let shellGroup: number | null = null;
const mainGroups: number[] = [];
let cleaned = false;

/** What undoing left undone, which fails the smoke however it ended. */
const leftUndone = (what: string): void => {
  process.exitCode = 1;
  process.stderr.write(`update smoke: ${what}\n`);
};

/** One step of undoing, which the next is taken after whatever it threw. */
const step = (what: string, undo: () => void): void => {
  try {
    undo();
  } catch (error) {
    leftUndone(`could not ${what}: ${String(error)}`);
  }
};

/** Undoes all the smoke did, once, synchronously, so a signal can run it too. Never throws. */
const cleanUp = (): void => {
  if (cleaned) {
    return;
  }
  cleaned = true;
  step("stop what the app started", () => {
    const running = processes();
    // the shell and the one it restarted as share a group; each main leads one of its own
    for (const group of [shellGroup, ...mainGroups]) {
      if (group !== null && running.some((each) => each.pgid === group)) {
        killGroup(group);
      }
    }
  });
  const opened = keychain;
  if (opened !== null) {
    // a key in the user's own keychains is one a launch made, having missed the smoke's: the smoke
    // refused to put its own first beside one, and a launch makes one only where it finds none. It
    // is looked for before the list is put back, after which a founder's IdleBiz may make one
    step("look for a key a launch made", () => {
      if (!holdsSealingKey(opened.found)) {
        return;
      }
      const deleted = spawnSync(
        "security",
        ["delete-generic-password", ...KEYCHAIN_ITEM, ...opened.found],
        { stdio: "ignore", timeout: KEYCHAIN_TIMEOUT_MS },
      );
      leftUndone(
        deleted.status === 0
          ? "a launch made a sealing key of its own in the user's Keychain, which the smoke deleted"
          : `a launch made a sealing key of its own in the user's Keychain, which the smoke could not delete: delete "${KEYCHAIN_SERVICE}" in Keychain Access`,
      );
    });
    step("put the Keychain back", () => {
      for (const failure of opened.restore()) {
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
  });
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    cleanUp();
    // the signal's own end, now that nothing it would leave is left
    process.kill(process.pid, signal);
  });
}
// an end the `finally` below never reaches: a throw outside its chain, such as an EPIPE on the
// shell's output relayed to a closed stdout, or process.exit
process.once("exit", cleanUp);

try {
  // ---- the feed, before the packs, which name its port

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

  // ---- the throwaway keys, in scratch: a, which the packs trust, and b, which signs the bad one

  const keys = path.join(scratch, "keys");
  await mkdir(keys);
  const signer = (what: string, signerArgs: readonly string[]): void => {
    run(what, "pnpm", ["exec", "tauri", "signer", ...signerArgs], {
      cwd: packageRoot,
      env: signerEnv,
    });
  };
  const keyA = path.join(keys, "a.key");
  const keyB = path.join(keys, "b.key");
  if (!reuse) {
    signer("make the key the packs trust", ["generate", "--ci", "-p", "", "-w", keyA]);
  }
  signer("make a key no pack trusts", ["generate", "--ci", "-p", "", "-w", keyB]);

  // ---- the packs: the one installed, N, and the update, N+1

  if (reuse) {
    log(`reusing the packs in ${packs}, which ask ${feedUrl}`);
  } else {
    const { version } = readJson(path.join(packageRoot, "package.json"), versionSchema);
    const [major, minor, patch] = semver(version);
    const pubkey = readFileSync(`${keyA}.pub`, "utf-8");
    // each spec parsed here, before a pack's minutes are spent on one package.ts would refuse
    const pack = (name: string, spec: z.input<typeof updateTestSpecSchema>): void => {
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
    pack("installed", {
      archive: false,
      feed: feedUrl,
      outDir: path.dirname(installedPack),
      pubkey,
      version,
    });
    pack("update", {
      archive: true,
      feed: feedUrl,
      key: keyA,
      outDir: updateDir,
      pubkey,
      version: `${major}.${minor}.${patch + 1}`,
    });
  }
  const from = bundleVersion(installedPack);
  const offered = readJson(packedFeed, feedSchema);
  const to = offered.version;
  if (bundleVersion(updatePack) !== to || !newer(to, from)) {
    throw new Error(
      `the packs are ${from} and ${bundleVersion(updatePack)}, offered as ${to}: the update is the newer, and its feed names it`,
    );
  }
  if (offered.platforms["darwin-aarch64"].url !== new URL(archiveName(to), feedUrl).href) {
    throw new Error(
      `the update's feed names ${offered.platforms["darwin-aarch64"].url}, not its archive on ${feedUrl}`,
    );
  }
  log(`IdleBiz ${from} is to update to ${to}`);

  // ---- the install, in a folder the account writes, so the swap asks for no admin password

  await mkdir(path.dirname(install));
  run("install the pack", "ditto", [installedPack, install]);
  log(`installed IdleBiz ${from} at ${install}`);

  // ---- the save, the Keychain, and the bad release

  run(
    "seed the save (see vitest's output above)",
    "pnpm",
    ["exec", "vitest", "run", "--config", "vitest.seed.config.ts"],
    {
      cwd: cliRoot,
      env: { ...process.env, IDLEBIZ_SEED_ROOT: save },
    },
  );
  const canaries = Object.entries(readJson(path.join(save, "secrets.json"), secretsSchema)).filter(
    ([name]) => name.startsWith("ENV/"),
  );
  const [canary] = canaries;
  if (canary === undefined || canaries.length !== 1) {
    throw new Error(`the seed left ${canaries.length} team values in secrets.json, not one`);
  }
  const [canaryName, canaryValue] = canary;
  log(`seeded Acme on ${save}, with ${canaryName} pasted as plain text`);

  keychain = openScratchKeychain(scratch, [install, updatePack]);
  const { key } = keychain;
  log(`${keychain.file} holds IdleBiz's key for both packs, first on the search list`);

  const archive = path.join(updateDir, archiveName(to));
  const badDir = path.join(scratch, "bad");
  await mkdir(badDir);
  const badCopy = path.join(badDir, archiveName(to));
  await copyFile(archive, badCopy, constants.COPYFILE_FICLONE);
  signer("sign the update with a key no pack trusts", [
    "sign",
    "-f",
    keyB,
    "-p",
    "",
    "--app-version",
    to,
    badCopy,
  ]);
  const goodFeed = await readFile(packedFeed);
  const badFeed = Buffer.from(
    `${JSON.stringify(loopbackFeed({ feed: feedUrl, publishedAt: new Date(), signature: await readFile(`${badCopy}.sig`, "utf-8"), version: to }), null, 2)}\n`,
  );
  feed.archive = archive;
  feed.body = goodFeed;

  // ---- N, booted on the save

  const swapRoots = [realpathSync.native(tmpdir()), path.dirname(install)];
  const swapsBefore = new Set(swapFolders(swapRoots));
  // fails a wait at once: two mains on the save, or a Keychain prompt holding a launch
  let promptLookedAt = 0;
  const refusal = (): string | null => {
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
        ? "macOS asks for leave in a SecurityAgent window nobody here answers: the Keychain's, when the scratch keychain's partition list did not let this pack read its key (update-keychain.ts), or an administrator's, when the swap was refused the install's folder"
        : null;
    } catch (error) {
      log(`could not look for a Keychain prompt: ${String(error)}`);
      return null;
    }
  };
  const rootOf = (main: Process): void => {
    const root = startingEnvOf(main).get("IDLEBIZ_ROOT_DIR");
    if (root !== save) {
      throw new Error(
        `main ${main.pid} serves ${root ?? "no save"}, not the one --root= named, ${save}`,
      );
    }
  };
  const proveSealed = (version: string): void => {
    if (openSealed(storedSecret(save, canaryName), canaryName, key) !== canaryValue) {
      throw new Error(
        `under IdleBiz ${version}, secrets.json's ${canaryName} is not sealed with the scratch keychain's key: main had another key, or none`,
      );
    }
  };
  const proveNoKeyOfItsOwn = (output: string, version: string): void => {
    const said = NO_KEY.find((line) => output.includes(line));
    if (said !== undefined) {
      throw new Error(`IdleBiz ${version} had no Keychain key: it said "${said}"`);
    }
    if (keychain !== null && holdsSealingKey(keychain.found)) {
      throw new Error(`IdleBiz ${version} made a sealing key of its own in the user's Keychain`);
    }
  };
  // one osascript a wait asks through can fail as System Events starts or the menu redraws, so the
  // wait asks again, and its sentence names the last failure
  let lookFailed: string | null = null;
  const look = <T>(read: () => T): T | null => {
    try {
      const seen = read();
      lookFailed = null;
      return seen;
    } catch (error) {
      lookFailed = error instanceof Error ? error.message : String(error);
      return null;
    }
  };
  const lastFailure = (): string =>
    lookFailed === null ? "" : `\nits last look failed: ${lookFailed}`;
  let lastTray: string[] = [];
  const waitForTray = (wanted: (items: string[]) => boolean, what: string): Promise<string[]> =>
    waitFor(
      () => {
        lastTray = look(trayItems) ?? lastTray;
        return lookFailed === null && wanted(lastTray) ? lastTray : null;
      },
      TRAY_TIMEOUT_MS,
      () =>
        `IdleBiz's menu-bar item did not ${what} within ${TRAY_TIMEOUT_MS}ms (a notification the shell is still posting holds main's redraws behind it, main_process.rs); it showed:\n  ${lastTray.join("\n  ")}${lastFailure()}`,
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
  // a process group of its own, which the shell it restarts as stays in
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
  proveSealed(from);
  proveNoKeyOfItsOwn(first.output(), from);
  log(
    `IdleBiz ${from} read the scratch keychain's key with no prompt and sealed ${canaryName} with it`,
  );
  await waitForTray(
    (items) => items.includes(OPEN_ITEM) && items.includes(offeredItem),
    `show "${OPEN_ITEM}" and "${offeredItem}"`,
  );
  log(`the menu-bar item opens Acme and offers "${offeredItem}"`);
  const before = snapshotOf(save);

  // ---- a release signed with a key the pack does not trust: refused before main stops

  feed.body = badFeed;
  let asked = requests.length;
  let said = first.output().length;
  clickTrayItem(UPDATE_ITEM);
  log(`clicked "${offeredItem}", the feed offering a signature by key b`);
  const box = await waitFor(
    () => {
      const text = look(dialogText);
      return text === "" ? null : text;
    },
    BOX_TIMEOUT_MS,
    () =>
      `IdleBiz showed no box within ${BOX_TIMEOUT_MS}ms of a click on "${offeredItem}" with a bad signature on offer${lastFailure()}\nits windows then:\n${describeWindows()}`,
  );
  if (!box.includes(NOT_DOWNLOADED)) {
    throw new Error(`the box a bad signature should open says something else:\n${box}`);
  }
  if (!requests.slice(asked).includes(`GET /${archiveName(to)}`)) {
    throw new Error(
      `IdleBiz said ${to} ${NOT_DOWNLOADED} without asking the feed for its archive:\n${box}`,
    );
  }
  log(`IdleBiz downloaded the archive and refused it in a box:\n${box}`);
  dismissDialog();
  await waitFor(
    () => (look(dialogText) === "" ? true : null),
    BOX_TIMEOUT_MS,
    () =>
      `IdleBiz's box stayed open after its OK was clicked${lastFailure()}\nits windows then:\n${describeWindows()}`,
  );
  if (first.output().slice(said).includes("main exited")) {
    throw new Error("main exited over a release whose signature the pack refused");
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

  // ---- the release the pack trusts: main stops, the app is replaced and starts again

  feed.body = goodFeed;
  asked = requests.length;
  said = first.output().length;
  clickTrayItem(UPDATE_ITEM);
  log(`clicked "${offeredItem}", the feed offering the update as packed`);
  await waitForLine(first, MAIN_EXITED_CLEANLY, { after: said, refusal });
  if (!requests.slice(asked).includes(`GET /${archiveName(to)}`)) {
    throw new Error("main stopped for an update the shell never downloaded");
  }
  log("the shell downloaded the update, checked its signature and stopped main as Quit does");
  // every request from here is the relaunched app's
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
      `IdleBiz ${from} was still running ${INSTALL_TIMEOUT_MS}ms after main stopped: the install or its restart hung`,
  );
  if (first.shell.exitCode !== 0) {
    throw new Error(`IdleBiz ${from} exited ${how(first.shell)}, not 0 as a restart does`);
  }
  const relaunchedArgs = `${installed.shellBinary} --root=${save}`;
  const relaunched = await waitFor(
    () => processes().find((each) => each.args === relaunchedArgs && each.pid !== shellPid) ?? null,
    RELAUNCH_TIMEOUT_MS,
    () =>
      `no shell ran \`${relaunchedArgs}\` within ${RELAUNCH_TIMEOUT_MS}ms of IdleBiz ${from} exiting: the restart lost the app or its save`,
  );
  if (relaunched.pgid !== shellPid) {
    throw new Error(
      `the shell the update restarted as leads group ${relaunched.pgid}, not ${shellPid}, the one it was restarted from`,
    );
  }
  log(`IdleBiz ${from} exited 0 and restarted as pid ${relaunched.pid}, on the same --root=`);
  await waitForLine(first, WINDOW_LOADED, { after: said, refusal, restartedAs: relaunched.pid });
  const nextMain = mainUnder(installed, relaunched.pid);
  mainGroups.push(nextMain.pgid);
  const mains = mainsOf(installed);
  if (nextMain.pid === firstMain.pid || mains.length !== 1) {
    throw new Error(
      `the relaunch serves the save on ${mains.length} mains, not one new one:\n  ${mains.map((each) => `${each.pid} ${each.args}`).join("\n  ")}`,
    );
  }
  rootOf(nextMain);
  log(`the relaunch booted one main (pid ${nextMain.pid}) on the same save, and its window loaded`);

  // ---- N+1, as installed

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
  // its check found itself current, which the menu shows once it redraws
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
  proveSealed(to);
  proveNoKeyOfItsOwn(first.output().slice(said), to);
  log(`the save is as IdleBiz ${from} left it, and ${to} reads the same Keychain key`);

  // ---- the quit

  said = first.output().length;
  process.kill(relaunched.pid, "SIGTERM");
  await waitFor(
    () => (isRunning(relaunched.pid) ? null : true),
    EXIT_TIMEOUT_MS,
    () => `IdleBiz ${to} was still running ${EXIT_TIMEOUT_MS}ms after SIGTERM`,
  );
  if (!first.output().slice(said).includes(MAIN_EXITED_CLEANLY)) {
    throw new Error(`IdleBiz ${to} quit without main exiting cleanly`);
  }
  const groups = new Set([shellPid, firstMain.pgid, nextMain.pgid]);
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
  const swapsLeft = swapFolders(swapRoots).filter((folder) => !swapsBefore.has(folder));
  if (swapsLeft.length > 0) {
    throw new Error(`the update left its swap folders behind:\n  ${swapsLeft.join("\n  ")}`);
  }
  log(`IdleBiz ${to} quit cleanly, and the update left no swap folder behind`);
  log("PASS");
} finally {
  cleanUp();
}
