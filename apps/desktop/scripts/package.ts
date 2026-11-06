// The Mac app's dmg, in .output/bin. The release material is read here, in the one process that
// packs, rather than from the shell's environment.
//
// Under IDLEBIZ_PACK_UPDATE_TEST=<spec.json> it packs a test pack instead (update-test-pack.ts):
// an ad-hoc .app on a loopback feed and a throwaway key, built from inputs and into a target of its
// own, apart from every other pack, and left in the spec's folder in scratch, never .output/bin. A
// release refuses one.
//
// `bundle.resources` and `externalBin` live in the config this writes, never in tauri.conf.json:
// tauri-build copies both on every cargo build, so a clippy run would copy main's 600 MB, and a
// checkout that never packaged would fail its typecheck for want of them.

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
// a test pack's: its shell has a test feed and pubkey compiled in, so it shares no artifact with
// another pack's
const testTargetDir = path.join(targetDir, "update-test");
const { version } = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf-8")));

// the release's one asset the site's download link finds, by its `.dmg`
const DMG_NAME = `IdleBiz-${version}-arm64.dmg`;
// node 24's own floor (its binary's LC_BUILD_VERSION): below it the sidecar cannot start. Its
// WebKit, Safari 16.6's, is the page's: vite.config.ts builds for it and tsconfig.page.json caps
// the stdlib at it, so the three move together
const MINIMUM_MACOS = "13.5";
// the archive the installed app updates from, beside the dmg in each release (release-feed.ts)
const ARCHIVE_NAME = archiveName(version);
// the key that signs each release's archive, made once with
// `pnpm -F @repo/desktop tauri signer generate -w ~/.tauri/idlebiz.key`: under HOME, where the seal
// keeps it from every run (`LOGINS` in apps/cli/src/server/agents/machine-seal.ts), never in the
// checkout, since whoever holds it ships code to every install
const UPDATER_KEY = path.join(homedir(), ".tauri", "idlebiz.key");

const log = (line: string): void => {
  process.stdout.write(`package: ${line}\n`);
};

const run = (file: string, args: readonly string[], options: SpawnSyncOptions = {}): void => {
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

// one of the folders Apple's altool searches for an App Store Connect key, which the seal keeps
// from every run (`LOGINS` in apps/cli/src/server/agents/machine-seal.ts): no path is
// configurable, since a key anywhere else, the checkout included, is one any run can read
const NOTARY_KEYS = path.join(homedir(), ".appstoreconnect", "private_keys");
const ENV_NAMES = new Set(["APPLE_API_ISSUER", "APPLE_API_KEY"]);

// apps/desktop/.env names the key by Tauri's own names, its .p8 under NOTARY_KEYS by the name Apple
// downloads it as
const notaryEnv = (): Notary | null => {
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
  };
};

// the Developer ID the keychain holds, or `-` for an ad-hoc pack, which opens on the Mac that built
// it and is made only when asked for: a missing certificate must not pass for a signed build
const signingIdentity = (): string => {
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

// what Tauri reads to notarize: only .env's may reach it, so a stale export in the shell never
// notarizes a pack .env did not ask for
const NOTARY_VARIABLES = new Set([
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_PATH",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
]);

// what `tauri build` signs the update with: only these reach it, so a stale export in the shell
// never signs a pack that is no release
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

// the key's password, from apps/desktop/.env: empty for a key made without one. A release stops
// before the build while the line is absent: tauri takes no password as an empty one, and a key
// that has one would fail to open only once the build and its notarization are done
const updaterPassword = (): string => {
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

// a release is one the installed app can update from, so it signs its archive with the release's
// key; no other pack does, and a test pack that is the update signs with its throwaway key
const updaterSigning = (): Record<string, string> | null => {
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
  // a feed this release could not be found from stops it before the build, not after
  releaseAssets(updater.endpoints[0], version);
  return {
    TAURI_SIGNING_PRIVATE_KEY: UPDATER_KEY,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: updaterPassword(),
  };
};

const findOne = async (dir: string, suffix: string): Promise<string> => {
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
// refused before anything is built while it could reach a release or another Mac
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
    // the system's, as the shell gives main: TMPDIR is what `launchctl setenv` could point elsewhere
    scratch: systemTempDir(),
    updaterKey: UPDATER_KEY,
  });
  if (spec.archive && !existsSync(spec.key)) {
    throw new Error(`a test pack signs its archive with ${spec.key}, which is missing`);
  }
  log(`a test pack of ${spec.version}, asking ${spec.feed}, left in ${spec.outDir}`);
}
const bundleDir = path.join(spec === null ? targetDir : testTargetDir, "release", "bundle");
// what the pack builds from, its config, server and notices: a test pack's apart, so a release
// packed beside it never builds from its config or its server
const inputsDir =
  spec === null
    ? path.join(packageRoot, ".output")
    : path.join(packageRoot, ".output", "update-test");
// the same, as the config names it from src-tauri
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
// a test pack that is the update signs it with its throwaway key, made without a password, and
// any other signs nothing
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

// the page first, then the server, which stages it beside its bundle
run("pnpm", ["run", "build"], { cwd: packageRoot });
run("pnpm", ["--filter", "idlebiz", "run", "build"], { cwd: packageRoot });
const staged = await stageServer(path.join(inputsDir, "staged-server"));
if (spec !== null) {
  // the server names the version its package.json does (apps/cli/src/paths.ts), so a test pack's
  // names its shell's
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
    // the signed archive the updater installs, beside the app: a release's, or the update a test
    // pack is
    createUpdaterArtifacts: signing !== null,
    externalBin: ["binaries/node"],
    macOS: {
      entitlements: "../resources/entitlements.mac.plist",
      // an ad-hoc pack carries no team, so library validation would refuse its own addons
      hardenedRuntime: signed,
      minimumSystemVersion: MINIMUM_MACOS,
      signingIdentity: identity,
    },
    resources: {
      [`${inputsFromShell}/notices/`]: "notices/",
      // the `idlebiz` package, the page and its resources inside (src-tauri/src/runtime.rs names it)
      [`${inputsFromShell}/staged-server/`]: "server/",
      // not `node/`: tauri-build copies the sidecar and the resources into one target folder, where
      // the sidecar is already a file named `node`, and a folder of that name fails the build
      "../resources/node/": "notices/node/",
    },
    // a test pack is installed from its .app, never a dmg
    targets: spec === null ? ["app", "dmg"] : ["app"],
  },
  // a test pack's version, feed and pubkey; nothing without one
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
  // the spec's folder in scratch, never .output/bin or an installed app's (refuseUpdateTest), and
  // nothing else in it removed
  await mkdir(spec.outDir, { recursive: true });
  const app = path.join(spec.outDir, "IdleBiz.app");
  // ditto merges into a folder already there, which would leave files the signature never named
  await rm(app, { force: true, recursive: true });
  run("ditto", [path.join(bundleDir, "macos", "IdleBiz.app"), app]);
  log(`${app}, IdleBiz ${spec.version} asking ${spec.feed}`);
  if (spec.archive) {
    const archive = await findOne(path.join(bundleDir, "macos"), ".app.tar.gz");
    const signature = await readFile(`${archive}.sig`, "utf-8");
    // an archive the release's key signed, however its file was reached (a copy, a hard link), is
    // one every install takes, so it never leaves the target
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
