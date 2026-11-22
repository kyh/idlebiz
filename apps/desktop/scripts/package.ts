import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { FEED_NAME, archiveName, releaseAssets, releaseFeed } from "./release-feed.ts";
import { writeRustNotices } from "./rust-notices.ts";
import { signResources } from "./sign-resources.ts";
import { systemTempDir } from "./packaged-app.ts";
import { stageServer } from "./stage-server.ts";
import {
  loopbackFeed,
  realPathOf,
  refuseUpdateTest,
  signedBy,
  updateTestConfig,
  updateTestSpecSchema,
} from "./update-test-pack.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const checkout = path.resolve(packageRoot, "..", "..");
const outDir = path.join(packageRoot, ".output", "bin");
const targetDir = path.join(packageRoot, "src-tauri", "target");
const testTargetDir = path.join(targetDir, "update-test");

const { version } = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf-8")));

const DMG_NAME = `IdleBiz-${version}-arm64.dmg`;
const MINIMUM_MACOS = "13.5";
const ARCHIVE_NAME = archiveName(version);
const UPDATER_KEY = path.join(homedir(), ".tauri", "idlebiz.key");

const log = (line: string) => {
  process.stdout.write(`package: ${line}\n`);
};

const run = (file: string, args: readonly string[], options: SpawnSyncOptions = {}) => {
  const result = spawnSync(file, args, { stdio: "inherit", ...options });

  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(" ")} exited ${result.status ?? result.signal}`);
  }
};

interface Notary {
  APPLE_API_ISSUER: string;
  APPLE_API_KEY: string;
  APPLE_API_KEY_PATH: string;
}

const NOTARY_KEYS = path.join(homedir(), ".appstoreconnect", "private_keys");
const ENV_NAMES = new Set(["APPLE_API_ISSUER", "APPLE_API_KEY"]);

const notaryEnv = () => {
  const file = path.join(packageRoot, ".env");

  if (!existsSync(file)) {
    return null;
  }

  const values = new Map<string, string>();

  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const match = /^(?<name>APPLE_[A-Z_]+)=(?<value>.+)$/u.exec(line.trim());

    if (match?.groups?.name !== undefined && match.groups.value !== undefined) {
      values.set(match.groups.name, match.groups.value);
    }
  }

  const unknown = [...values.keys()].filter((name) => !ENV_NAMES.has(name));

  if (unknown.length > 0) {
    throw new Error(
      `apps/desktop/.env names ${unknown.join(", ")}: it holds only ${[...ENV_NAMES].join(" and ")}, and the key's .p8 sits in ${NOTARY_KEYS}`,
    );
  }

  const issuer = values.get("APPLE_API_ISSUER");
  const keyId = values.get("APPLE_API_KEY");

  if (issuer === undefined || keyId === undefined) {
    return null;
  }

  const keyPath = path.join(NOTARY_KEYS, `AuthKey_${keyId}.p8`);

  if (!existsSync(keyPath)) {
    throw new Error(
      `apps/desktop/.env names a notary key, but ${keyPath} is missing: move the key's .p8 there`,
    );
  }

  return {
    APPLE_API_ISSUER: issuer,
    APPLE_API_KEY: keyId,
    APPLE_API_KEY_PATH: keyPath,
  } satisfies Notary | null;
};

const signingIdentity = () => {
  if (process.env.IDLEBIZ_PACK_UNSIGNED === "1") {
    return "-";
  }

  if (process.env.APPLE_SIGNING_IDENTITY !== undefined) {
    return process.env.APPLE_SIGNING_IDENTITY;
  }

  const listed = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf-8",
  });

  const identity = /"(?<identity>Developer ID Application: [^"]+)"/u.exec(listed.stdout)?.groups
    ?.identity;

  if (identity === undefined) {
    throw new Error(
      "the keychain holds no Developer ID Application identity: install one, name it in APPLE_SIGNING_IDENTITY, or set IDLEBIZ_PACK_UNSIGNED=1 for an ad-hoc pack that opens on this Mac alone",
    );
  }

  return identity;
};

const NOTARY_VARIABLES = new Set([
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_PATH",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
]);

const SIGNING_VARIABLES = new Set([
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
]);

const {
  plugins: { updater },
} = z
  .object({
    plugins: z.object({
      updater: z.object({ endpoints: z.tuple([z.string()]), pubkey: z.string() }),
    }),
  })
  .parse(JSON.parse(readFileSync(path.join(packageRoot, "src-tauri", "tauri.conf.json"), "utf-8")));

const updaterPassword = () => {
  const file = path.join(packageRoot, ".env");
  const name = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=";

  const line = existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .map((each) => each.trim())
        .find((each) => each.startsWith(name))
    : undefined;

  if (line === undefined) {
    throw new Error(
      `a release signs its update with ${UPDATER_KEY}, whose password apps/desktop/.env's ${name} line holds: add the line, empty for a key made without one (see .env.example)`,
    );
  }

  return line.slice(name.length);
};

const updaterSigning = () => {
  if (process.env.IDLEBIZ_RELEASE !== "1") {
    return null;
  }

  if (updater.pubkey === "") {
    throw new Error(
      `a release is signed for the updater, but src-tauri/tauri.conf.json's plugins.updater.pubkey is empty: make the key once with \`pnpm -F @repo/desktop tauri signer generate -w ${UPDATER_KEY}\` and paste its .pub file's contents there`,
    );
  }

  if (!existsSync(UPDATER_KEY)) {
    throw new Error(`a release signs its update with ${UPDATER_KEY}, which is missing`);
  }

  releaseAssets(updater.endpoints[0], version);

  return {
    TAURI_SIGNING_PRIVATE_KEY: UPDATER_KEY,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: updaterPassword(),
  } satisfies Record<string, string> | null;
};

const findOne = async (dir: string, suffix: string) => {
  const entries = await readdir(dir);
  const names = entries.filter((name) => name.endsWith(suffix));
  const [only] = names;

  if (only === undefined || names.length !== 1) {
    throw new Error(`expected one *${suffix} in ${dir}, found ${names.length}`);
  }

  return path.join(dir, only);
};

if (process.platform !== "darwin") {
  throw new Error("the Mac app packs on a Mac: codesign, hdiutil and notarytool are macOS's");
}

const identity = signingIdentity();
const specFile = process.env.IDLEBIZ_PACK_UPDATE_TEST;

const spec =
  specFile === undefined
    ? null
    : updateTestSpecSchema.parse(JSON.parse(readFileSync(specFile, "utf-8")));

if (spec !== null) {
  refuseUpdateTest(spec, {
    checkout,
    identity,
    installed: ["/Applications", path.join(homedir(), "Applications")],
    pubkey: updater.pubkey,
    real: realPathOf,
    release: process.env.IDLEBIZ_RELEASE === "1",
    releaseOut: outDir,
    scratch: systemTempDir(),
    updaterKey: UPDATER_KEY,
  });

  if (spec.archive && !existsSync(spec.key)) {
    throw new Error(`a test pack signs its archive with ${spec.key}, which is missing`);
  }

  log(`a test pack of ${spec.version}, asking ${spec.feed}, left in ${spec.outDir}`);
}

const bundleDir = path.join(spec === null ? targetDir : testTargetDir, "release", "bundle");

const inputsDir =
  spec === null
    ? path.join(packageRoot, ".output")
    : path.join(packageRoot, ".output", "update-test");

const inputsFromShell = spec === null ? "../.output" : "../.output/update-test";
const signed = identity !== "-";
const notary = signed ? notaryEnv() : null;

if (process.env.IDLEBIZ_RELEASE === "1" && notary === null) {
  throw new Error(
    "a release is signed with a Developer ID and notarized: apps/desktop/.env names no complete notary key",
  );
}

log(signed ? `signing as ${identity}` : "signing ad-hoc: this pack opens only on this Mac");

log(
  notary === null
    ? "apps/desktop/.env names no notary key — not notarized"
    : `notarizing with ${notary.APPLE_API_KEY_PATH}`,
);

const testSigning =
  spec?.archive === true
    ? { TAURI_SIGNING_PRIVATE_KEY: spec.key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" }
    : null;

const signing = spec === null ? updaterSigning() : testSigning;

if (spec === null) {
  log(
    signing === null
      ? "no update archive: not a release"
      : `signing the update with ${UPDATER_KEY}`,
  );
} else {
  log(
    spec.archive
      ? `signing the update with ${spec.key}`
      : "no update archive: this test pack is not the update",
  );
}

run("pnpm", ["run", "build"], { cwd: packageRoot });

run("pnpm", ["--filter", "idlebiz", "run", "build"], { cwd: packageRoot });

const staged = await stageServer(path.join(inputsDir, "staged-server"));

if (spec !== null) {
  const manifest = path.join(staged, "package.json");

  const fields = z
    .looseObject({ version: z.string() })
    .parse(JSON.parse(await readFile(manifest, "utf-8")));

  await writeFile(manifest, `${JSON.stringify({ ...fields, version: spec.version }, null, 2)}\n`);
}

const resourceCount = await signResources([staged], identity, signed);

log(`signed ${resourceCount} binaries the server's dependencies carry`);

const crateCount = await writeRustNotices(
  path.join(packageRoot, "src-tauri"),
  path.join(inputsDir, "notices", "rust-crates.txt"),
);

log(`noted the licences of the ${crateCount} Rust crates the shell links`);

const config = {
  bundle: {
    createUpdaterArtifacts: signing !== null,
    externalBin: ["binaries/node"],
    macOS: {
      entitlements: "../resources/entitlements.mac.plist",
      hardenedRuntime: signed,
      minimumSystemVersion: MINIMUM_MACOS,
      signingIdentity: identity,
    },
    resources: {
      [`${inputsFromShell}/notices/`]: "notices/",
      [`${inputsFromShell}/staged-server/`]: "server/",
      "../resources/node/": "notices/node/",
    },
    targets: spec === null ? ["app", "dmg"] : ["app"],
  },
  ...updateTestConfig(spec),
};

const configFile = path.join(inputsDir, "tauri.package.conf.json");

await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);

await rm(bundleDir, { force: true, recursive: true });

const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !NOTARY_VARIABLES.has(name) && !SIGNING_VARIABLES.has(name),
  ),
);

const buildEnv: NodeJS.ProcessEnv = { ...inherited, ...notary, ...signing };

if (spec !== null) {
  buildEnv.CARGO_TARGET_DIR = testTargetDir;
}

run("pnpm", ["exec", "tauri", "build", "--config", configFile], {
  cwd: packageRoot,
  env: buildEnv,
});

if (spec === null) {
  await rm(outDir, { force: true, recursive: true });
  await mkdir(outDir, { recursive: true });
  await copyFile(await findOne(path.join(bundleDir, "dmg"), ".dmg"), path.join(outDir, DMG_NAME));
  log(
    `${path.join("src-tauri", "target", "release", "bundle", "macos", "IdleBiz.app")} and ${DMG_NAME}`,
  );

  if (signing !== null) {
    const archive = await findOne(path.join(bundleDir, "macos"), ".app.tar.gz");
    await copyFile(archive, path.join(outDir, ARCHIVE_NAME));
    const signature = await readFile(`${archive}.sig`, "utf-8");

    const feed = releaseFeed({
      feed: updater.endpoints[0],
      publishedAt: new Date(),
      signature,
      version,
    });

    await writeFile(path.join(outDir, FEED_NAME), `${JSON.stringify(feed, null, 2)}\n`);
    log(`${ARCHIVE_NAME} and ${FEED_NAME}, for the installed app's updater`);
  }
} else {
  await mkdir(spec.outDir, { recursive: true });
  const app = path.join(spec.outDir, "IdleBiz.app");
  await rm(app, { force: true, recursive: true });
  run("ditto", [path.join(bundleDir, "macos", "IdleBiz.app"), app]);
  log(`${app}, IdleBiz ${spec.version} asking ${spec.feed}`);

  if (spec.archive) {
    const archive = await findOne(path.join(bundleDir, "macos"), ".app.tar.gz");
    const signature = await readFile(`${archive}.sig`, "utf-8");

    if (signedBy(signature, updater.pubkey)) {
      await rm(archive, { force: true });
      await rm(`${archive}.sig`, { force: true });
      throw new Error(
        `${spec.key} is the release's key, so the archive it signed is removed: a test pack signs with a throwaway key made in scratch`,
      );
    }

    await copyFile(archive, path.join(spec.outDir, archiveName(spec.version)));

    const feed = loopbackFeed({
      feed: spec.feed,
      publishedAt: new Date(),
      signature,
      version: spec.version,
    });

    await writeFile(path.join(spec.outDir, FEED_NAME), `${JSON.stringify(feed, null, 2)}\n`);
    log(`${archiveName(spec.version)} and ${FEED_NAME}, for ${spec.feed} to serve`);
  }
}
