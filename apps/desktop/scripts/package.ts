// The Mac app's dmg, in .output/bin. The release material is read here, in the one process that
// packs, rather than from the shell's environment.
//
// `bundle.resources` and `externalBin` live in the config this writes, never in tauri.conf.json:
// tauri-build copies both on every cargo build, so a clippy run would copy main's 600 MB, and a
// checkout that never packaged would fail its typecheck for want of them.

import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { writeRustNotices } from "./rust-notices.ts";
import { signResources } from "./sign-resources.ts";
import { stageServer } from "./stage-server.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const outDir = path.join(packageRoot, ".output", "bin");
const bundleDir = path.join(packageRoot, "src-tauri", "target", "release", "bundle");
const { version } = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf-8")));

// the release's one asset the site's download link finds, by its `.dmg`
const DMG_NAME = `IdleBiz-${version}-arm64.dmg`;
// node 24's own floor (its binary's LC_BUILD_VERSION): below it the sidecar cannot start
const MINIMUM_MACOS = "13.5";

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
// from every run (`LOGINS` in apps/cli/src/server/agents/seal.ts): no path is configurable,
// since a key anywhere else, the checkout included, is one any run can read
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

// the page first, then the server, which stages it beside its bundle
run("pnpm", ["run", "build"], { cwd: packageRoot });
run("pnpm", ["--filter", "idlebiz", "run", "build"], { cwd: packageRoot });
const staged = await stageServer(path.join(packageRoot, ".output", "staged-server"));
const resourceCount = await signResources([staged], identity, signed);
log(`signed ${resourceCount} binaries the server's dependencies carry`);
const crateCount = await writeRustNotices(
  path.join(packageRoot, "src-tauri"),
  path.join(packageRoot, ".output", "notices", "rust-crates.txt"),
);
log(`noted the licences of the ${crateCount} Rust crates the shell links`);

const config = {
  bundle: {
    externalBin: ["binaries/node"],
    macOS: {
      entitlements: "../resources/entitlements.mac.plist",
      // an ad-hoc pack carries no team, so library validation would refuse its own addons
      hardenedRuntime: signed,
      minimumSystemVersion: MINIMUM_MACOS,
      signingIdentity: identity,
    },
    resources: {
      "../.output/notices/": "notices/",
      // the `idlebiz` package, the page and its resources inside (src-tauri/src/runtime.rs names it)
      "../.output/staged-server/": "server/",
      // not `node/`: tauri-build copies the sidecar and the resources into one target folder, where
      // the sidecar is already a file named `node`, and a folder of that name fails the build
      "../resources/node/": "notices/node/",
    },
    targets: ["app", "dmg"],
  },
};
const configFile = path.join(packageRoot, ".output", "tauri.package.conf.json");
await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);

await rm(bundleDir, { force: true, recursive: true });
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !NOTARY_VARIABLES.has(name)),
);
run("pnpm", ["exec", "tauri", "build", "--config", configFile], {
  cwd: packageRoot,
  env: { ...inherited, ...notary },
});

await rm(outDir, { force: true, recursive: true });
await mkdir(outDir, { recursive: true });
await copyFile(await findOne(path.join(bundleDir, "dmg"), ".dmg"), path.join(outDir, DMG_NAME));
log(
  `${path.join("src-tauri", "target", "release", "bundle", "macos", "IdleBiz.app")} and ${DMG_NAME}`,
);
