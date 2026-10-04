// The Mac app: the shell, the node beside it and main as a resource, signed, notarized when
// apps/desktop/.env holds the notary's key, and the release's dmg in .output/bin. The release
// material is read HERE, in the one process that packs, rather than from the shell's environment.
//
// `bundle.resources` and `externalBin` live in the config this writes, never in tauri.conf.json:
// tauri-build copies both on every cargo build, so a clippy run would copy main's 600 MB, and a
// checkout that never packaged would fail its typecheck for want of them. The same steps as
// kyh/inteligir's.

import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeRustNotices } from "./rust-notices.ts";
import { signResources } from "./sign-resources.ts";
import { stageMain } from "./stage-main.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const outDir = path.join(packageRoot, ".output", "bin");
const bundleDir = path.join(packageRoot, "src-tauri", "target", "release", "bundle");
const { version } = z
  .object({ version: z.string() })
  .parse(JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf-8")));

// the name electron-builder gave it, which the site's download link finds by its `.dmg`
const DMG_NAME = `IdleBiz-${version}-arm64.dmg`;
// node 24's own floor (its binary's LC_BUILD_VERSION), which the Electron builds ran below
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

// apps/desktop/.env, in electron-builder's names, which Tauri reads under its own:
// APPLE_API_KEY is the .p8's path there, its id here
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
  const issuer = values.get("APPLE_API_ISSUER");
  const keyPath = values.get("APPLE_API_KEY");
  const keyId = values.get("APPLE_API_KEY_ID");
  if (issuer === undefined || keyPath === undefined || keyId === undefined) {
    return null;
  }
  return {
    APPLE_API_ISSUER: issuer,
    APPLE_API_KEY: keyId,
    APPLE_API_KEY_PATH: path.resolve(packageRoot, keyPath),
  };
};

// the Developer ID the keychain holds, or `-` for an ad-hoc pack, which opens on the Mac that built it
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
  const match = /"(?<identity>Developer ID Application: [^"]+)"/u.exec(listed.stdout);
  return match?.groups?.identity ?? "-";
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
const signed = identity !== "-";
const notary = signed ? notaryEnv() : null;
log(signed ? `signing as ${identity}` : "signing ad-hoc: this pack opens only on this Mac");
log(
  notary === null
    ? "apps/desktop/.env holds no notary key — not notarized"
    : "notarizing with apps/desktop/.env's key",
);

run("pnpm", ["run", "build"], { cwd: packageRoot });
const staged = await stageMain(path.join(packageRoot, ".output", "staged-main"));
const resourceCount = await signResources([staged], identity, signed);
log(`signed ${resourceCount} binaries main's dependencies carry`);
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
      "../.output/staged-main/": "main/",
      "../resources/employee-sheets/": "employee-sheets/",
      // not `node/`: tauri-build copies the sidecar and the resources into one target folder, where
      // the sidecar is already a file named `node`, and a folder of that name fails the build
      "../resources/node/": "notices/node/",
      "../resources/skills/": "skills/",
    },
    targets: ["app", "dmg"],
  },
};
const configFile = path.join(packageRoot, ".output", "tauri.package.conf.json");
await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);

await rm(bundleDir, { force: true, recursive: true });
run("pnpm", ["exec", "tauri", "build", "--config", configFile], {
  cwd: packageRoot,
  env: { ...process.env, ...notary },
});

await rm(outDir, { force: true, recursive: true });
await mkdir(outDir, { recursive: true });
await copyFile(await findOne(path.join(bundleDir, "dmg"), ".dmg"), path.join(outDir, DMG_NAME));
log(
  `${path.join("src-tauri", "target", "release", "bundle", "macos", "IdleBiz.app")} and ${DMG_NAME}`,
);
