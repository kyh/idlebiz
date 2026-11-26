import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Arch, Platform, build } from "electron-builder";
import type { Configuration } from "electron-builder";
import { z } from "zod";
import { systemTempDir } from "./packaged-app.ts";
import { signResources } from "./sign-resources.ts";
import { stageServer } from "./stage-server.ts";
import { signAs } from "./test-identity.ts";
import {
  APP_UPDATE_FILE,
  FEED_NAME,
  appUpdateYml,
  loopbackFeed,
  realPathOf,
  refuseUpdateTest,
  trustedIdentitiesIn,
  updateTestSpecSchema,
  zipName,
} from "./update-test-pack.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const checkout = path.resolve(packageRoot, "..", "..");
const envFile = path.join(checkout, ".env");
const outDir = path.join(packageRoot, ".output", "bin");

const { version } = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf-8")));

const DMG_NAME = `IdleBiz-${version}-arm64.dmg`;
const MINIMUM_MACOS = "13.5";
const DEVELOPER_ID = "Developer ID Application: ";
const RELEASE_REPO = { owner: "kyh", repo: "idlebiz" } as const;
const ENTITLEMENTS = path.join(packageRoot, "resources", "entitlements.mac.plist");

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
  issuer: string;
  keyId: string;
  keyPath: string;
}

const NOTARY_KEYS = path.join(homedir(), ".appstoreconnect", "private_keys");
const ENV_NAMES = new Set(["APPLE_API_ISSUER", "APPLE_API_KEY"]);

const notaryOf = () => {
  if (!existsSync(envFile)) {
    return null;
  }

  const values = new Map<string, string>();

  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const match = /^(?<name>APPLE_[A-Z_]+)=(?<value>.+)$/u.exec(line.trim());

    if (match?.groups?.name !== undefined && match.groups.value !== undefined) {
      values.set(match.groups.name, match.groups.value);
    }
  }

  const unknown = [...values.keys()].filter((name) => !ENV_NAMES.has(name));

  if (unknown.length > 0) {
    throw new Error(
      `the root .env names ${unknown.join(", ")}: it holds only ${[...ENV_NAMES].join(" and ")}, and the key's .p8 sits in ${NOTARY_KEYS}`,
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
      `the root .env names a notary key, but ${keyPath} is missing: move the key's .p8 there`,
    );
  }

  return { issuer, keyId, keyPath } satisfies Notary | null;
};

const listedIdentities = () =>
  spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf-8" }).stdout;

const developerId = () => {
  if (process.env.IDLEBIZ_PACK_UNSIGNED === "1") {
    return null;
  }

  if (process.env.APPLE_SIGNING_IDENTITY !== undefined) {
    return process.env.APPLE_SIGNING_IDENTITY;
  }

  const identity = /"(?<identity>Developer ID Application: [^"]+)"/u.exec(listedIdentities())
    ?.groups?.identity;

  if (identity === undefined) {
    throw new Error(
      "the keychain holds no Developer ID Application identity: install one, name it in APPLE_SIGNING_IDENTITY, or set IDLEBIZ_PACK_UNSIGNED=1 for an ad-hoc pack that opens on this Mac alone",
    );
  }

  return identity;
};

const NOTARY_VARIABLES = [
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_KEYCHAIN",
  "APPLE_KEYCHAIN_PROFILE",
  "APPLE_TEAM_ID",
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "CSC_NAME",
  "CSC_IDENTITY_AUTO_DISCOVERY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "IDLEBIZ_TEST_PACK_ROOT",
] as const;

const sha512Of = async (file: string) => {
  const hash = createHash("sha512");

  for await (const chunk of createReadStream(file)) {
    hash.update(z.instanceof(Buffer).parse(chunk));
  }

  return hash.digest("base64");
};

if (process.platform !== "darwin") {
  throw new Error("the Mac app packs on a Mac: codesign, hdiutil and notarytool are macOS's");
}

for (const name of NOTARY_VARIABLES) {
  Reflect.deleteProperty(process.env, name);
}

const release = process.env.IDLEBIZ_RELEASE === "1";
const specFile = process.env.IDLEBIZ_PACK_UPDATE_TEST;

const spec =
  specFile === undefined
    ? null
    : updateTestSpecSchema.parse(JSON.parse(readFileSync(specFile, "utf-8")));

if (spec !== null) {
  refuseUpdateTest(spec, {
    checkout,
    installed: ["/Applications", path.join(homedir(), "Applications")],
    real: realPathOf,
    release,
    releaseOut: outDir,
    scratch: systemTempDir(),
    trusted: trustedIdentitiesIn(listedIdentities()),
  });

  log(`a test pack of ${spec.version}, asking ${spec.feed}, left in ${spec.outDir}`);
}

const identity = spec === null ? developerId() : null;
const notary = identity === null ? null : notaryOf();

if (release && (identity === null || notary === null)) {
  throw new Error(
    "a release is signed with a Developer ID and notarized: set no IDLEBIZ_PACK_UNSIGNED, and name a complete notary key in the root .env",
  );
}

if (spec === null) {
  log(
    identity === null
      ? "signing ad-hoc: this pack opens only on this Mac"
      : `signing as ${identity}`,
  );
  log(notary === null ? "no notary key: not notarized" : `notarizing with ${notary.keyPath}`);
  log(
    release
      ? `a release, for github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}`
      : "not a release: it takes no updates",
  );
} else {
  log(`signing as the throwaway identity ${spec.identity}`);
}

const inputsDir = path.join(packageRoot, ".output", spec === null ? "pack" : "update-test");
const builtDir = path.join(inputsDir, "built");

run("pnpm", ["run", "build"], { cwd: packageRoot });

run("pnpm", ["run", "build:shell"], {
  cwd: packageRoot,
  env: spec === null ? process.env : { ...process.env, IDLEBIZ_TEST_PACK_ROOT: spec.root },
});

run("pnpm", ["--filter", "idlebiz", "run", "build"], { cwd: packageRoot });

const staged = await stageServer(path.join(inputsDir, "staged-server"));

if (spec !== null) {
  const manifest = path.join(staged, "package.json");

  const fields = z
    .looseObject({ version: z.string() })
    .parse(JSON.parse(await readFile(manifest, "utf-8")));

  await writeFile(manifest, `${JSON.stringify({ ...fields, version: spec.version }, null, 2)}\n`);
}

const resourceCount = await signResources([staged], identity ?? "-", identity !== null);

log(`signed ${resourceCount} binaries the server's dependencies carry`);

const notices = path.join(inputsDir, "notices");

await rm(notices, { force: true, recursive: true });

await mkdir(notices, { recursive: true });

await copyFile(
  path.join(packageRoot, ".output", "app", "shell", "shell-packages.md"),
  path.join(notices, "shell-packages.md"),
);

const builderIdentity = () => {
  if (identity !== null) {
    return identity.replace(DEVELOPER_ID, "");
  }

  return spec === null ? "-" : null;
};

const config = {
  appId: "com.idlebiz.desktop",
  asar: true,
  directories: { buildResources: "resources", output: builtDir },
  dmg: { artifactName: DMG_NAME },
  electronFuses: {
    enableCookieEncryption: false,
    enableEmbeddedAsarIntegrityValidation: true,
    enableNodeCliInspectArguments: false,
    enableNodeOptionsEnvironmentVariable: false,
    grantFileProtocolExtraPrivileges: false,
    onlyLoadAppFromAsar: true,
    runAsNode: false,
  },
  extraFiles: [{ from: ".cache/bundled-node/node", to: "MacOS/node" }],
  extraMetadata: spec === null ? {} : { version: spec.version },
  extraResources: [
    { from: staged, to: "server" },
    { from: notices, to: "notices" },
    { from: "resources/node", to: "notices/node" },
    { from: "resources/tray.png", to: "tray.png" },
  ],
  files: [".output/app/**", "!.output/app/**/*.md", "package.json"],
  mac: {
    artifactName: zipName(version),
    category: "public.app-category.games",
    entitlements: ENTITLEMENTS,
    entitlementsInherit: ENTITLEMENTS,
    hardenedRuntime: identity !== null,
    icon: "resources/icon.icns",
    identity: builderIdentity(),
    minimumSystemVersion: MINIMUM_MACOS,
    notarize: notary !== null,
  },
  productName: "IdleBiz",
  publish: release ? { provider: "github", ...RELEASE_REPO } : null,
} satisfies Configuration;

if (notary !== null) {
  process.env.APPLE_API_KEY = notary.keyPath;
  process.env.APPLE_API_KEY_ID = notary.keyId;
  process.env.APPLE_API_ISSUER = notary.issuer;
}

process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

await rm(builtDir, { force: true, recursive: true });

const targetsOf = () => {
  if (spec !== null) {
    return ["dir"];
  }

  return release ? ["dmg", "zip"] : ["dmg"];
};

await build({
  config,
  projectDir: packageRoot,
  publish: "never",
  targets: Platform.MAC.createTarget(targetsOf(), Arch.arm64),
});

const builtApp = path.join(builtDir, "mac-arm64", "IdleBiz.app");

if (spec === null) {
  await rm(outDir, { force: true, recursive: true });
  await mkdir(outDir, { recursive: true });
  run("ditto", [builtApp, path.join(outDir, "IdleBiz.app")]);
  await copyFile(path.join(builtDir, DMG_NAME), path.join(outDir, DMG_NAME));

  if (notary !== null) {
    run("xcrun", [
      "notarytool",
      "submit",
      path.join(outDir, DMG_NAME),
      "--key",
      notary.keyPath,
      "--key-id",
      notary.keyId,
      "--issuer",
      notary.issuer,
      "--wait",
    ]);
    run("xcrun", ["stapler", "staple", path.join(outDir, DMG_NAME)]);
  }

  log(`${path.join(".output", "bin", "IdleBiz.app")} and ${DMG_NAME}`);

  if (release) {
    for (const asset of [zipName(version), `${zipName(version)}.blockmap`, FEED_NAME]) {
      await copyFile(path.join(builtDir, asset), path.join(outDir, asset));
    }

    log(`${zipName(version)} and ${FEED_NAME}, for the installed app's updater`);
  }
} else {
  await writeFile(
    path.join(builtApp, "Contents", "Resources", APP_UPDATE_FILE),
    appUpdateYml(spec.feed),
  );
  signAs(builtApp, spec.identity, spec.keychain);
  await mkdir(spec.outDir, { recursive: true });
  const app = path.join(spec.outDir, "IdleBiz.app");
  await rm(app, { force: true, recursive: true });
  run("ditto", [builtApp, app]);
  log(`${app}, IdleBiz ${spec.version} asking ${spec.feed}`);

  if (spec.archive) {
    const zip = path.join(spec.outDir, zipName(spec.version));
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);

    const feed = loopbackFeed({
      feed: spec.feed,
      releasedAt: new Date(),
      sha512: await sha512Of(zip),
      size: statSync(zip).size,
      version: spec.version,
    });

    await writeFile(path.join(spec.outDir, FEED_NAME), feed);
    log(`${zipName(spec.version)} and ${FEED_NAME}, for ${spec.feed} to serve`);
  }
}
