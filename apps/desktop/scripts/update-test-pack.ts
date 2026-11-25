import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** The feed electron-updater asks a generic provider's url for, on a Mac. */
export const FEED_NAME = "latest-mac.yml";

/** The file electron-updater reads the installed app's feed from, in `Contents/Resources`. */
export const APP_UPDATE_FILE = "app-update.yml";

const UPDATER_CACHE = "idlebiz-updater";

/** The zip a Mac pack of `version` is served as, as electron-builder names a release's. */
export const zipName = (version: string) => `IdleBiz-${version}-arm64-mac.zip`;

const absolutePath = z.string().refine((file) => path.isAbsolute(file), "an absolute path");

/**
 * What IDLEBIZ_PACK_UPDATE_TEST names: one test pack, the update (`archive`) or one it updates,
 * signed by a throwaway identity in a scratch keychain, since Squirrel.Mac installs only an update
 * signed by the identity the running app is.
 */
export const updateTestSpecSchema = z.strictObject({
  /** Whether the pack is the update: it makes its zip and the feed naming it. */
  archive: z.boolean(),
  feed: z.string(),
  /** The SHA-1 of the throwaway identity that signs the pack. */
  identity: z.string().regex(/^[0-9A-F]{40}$/u, "an identity's SHA-1, in capitals"),
  /** The scratch keychain that holds the identity. */
  keychain: absolutePath,
  outDir: absolutePath,
  /**
   * The save the pack opens with no `--root=`: Squirrel.Mac relaunches an update with no
   * arguments, so a test pack carries its save in its shell.
   */
  root: absolutePath,
  version: z.string().regex(/^\d+\.\d+\.\d+$/u, "a version such as 0.0.11"),
});

type UpdateTestSpec = z.infer<typeof updateTestSpecSchema>;

/** The pack a spec would change, as package.ts knows it. */
interface Pack {
  /** Whether the pack is a release (`IDLEBIZ_RELEASE=1`). */
  release: boolean;
  /** The SHA-1s of the identities macOS trusts to sign code: a Developer ID's among them. */
  trusted: readonly string[];
  /** The checkout, which every run can read. */
  checkout: string;
  /** Where a release leaves its assets, which publish-release.sh uploads. */
  releaseOut: string;
  /** The OS's temporary folder, where a test pack's keychain, save and folder lie. */
  scratch: string;
  /**
   * The folders apps are installed in (`/Applications`, `~/Applications`), refused whatever scratch
   * is: a test pack replaces the .app in its folder, and scratch is read from the environment.
   */
  installed: readonly string[];
  /** A path as the file system resolves it, through every link in it, as the disk spells it. */
  real: (file: string) => string;
}

const isLoopbackFeed = (feed: string) => {
  const port = /^http:\/\/127\.0\.0\.1:(?<port>[1-9]\d{0,4})\//u.exec(feed)?.groups?.port;

  return (
    port !== undefined && Number(port) <= 65_535 && feed === `http://127.0.0.1:${port}/${FEED_NAME}`
  );
};

const offLoopback = (feed: string) =>
  `a test pack's feed is http://127.0.0.1:<port>/${FEED_NAME}, which this Mac alone answers, not ${feed}`;

const within = (dir: string, file: string) => {
  const relative = path.relative(dir, file);

  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

const inScratchRefusals = (what: string, named: string, scratch: string, pack: Pack) => {
  const file = pack.real(named);

  return [
    [!within(scratch, file), `a test pack's ${what} lies in scratch (${scratch}): ${named}`],
    [
      within(pack.real(pack.checkout), file),
      `a test pack's ${what} is never in the checkout, which every run can read: ${named}`,
    ],
  ] satisfies [boolean, string][];
};

const refusalsOf = (spec: UpdateTestSpec, pack: Pack) => {
  const scratch = pack.real(pack.scratch);
  const outDir = pack.real(spec.outDir);

  const rules: [refused: boolean, refusal: string][] = [
    [
      pack.release,
      "a test pack is never a release: its feed and identity are ones no installed app may take, so unset IDLEBIZ_PACK_UPDATE_TEST or IDLEBIZ_RELEASE",
    ],
    [
      pack.trusted.includes(spec.identity),
      `a test pack signs with a throwaway identity no Mac trusts, never one macOS trusts to sign code, as a Developer ID is: ${spec.identity}`,
    ],
    [!isLoopbackFeed(spec.feed), offLoopback(spec.feed)],
    ...inScratchRefusals("keychain", spec.keychain, scratch, pack),
    ...inScratchRefusals("save", spec.root, scratch, pack),
    [
      !within(scratch, outDir),
      `a test pack's folder lies in scratch (${scratch}), never where an installed app is: ${spec.outDir}`,
    ],
    [
      pack.installed.some((dir) => within(pack.real(dir), outDir)),
      `a test pack never leaves anything where apps are installed, whatever scratch is: ${spec.outDir}`,
    ],
    [
      within(pack.real(pack.releaseOut), outDir),
      `a test pack never leaves anything in ${pack.releaseOut}, which publishing uploads: ${spec.outDir}`,
    ],
  ];

  return rules.flatMap(([refused, refusal]) => (refused ? [refusal] : []));
};

/**
 * Throws, naming each, while `spec` is a test pack that could reach a release, another Mac or the
 * installed app: a release, an identity macOS trusts, a feed off loopback, a keychain, save or
 * folder outside scratch or in the checkout, or the folder a release is published from.
 */
export const refuseUpdateTest = (spec: UpdateTestSpec, pack: Pack) => {
  const refusals = refusalsOf(spec, pack);

  if (refusals.length > 0) {
    throw new Error(
      `IDLEBIZ_PACK_UPDATE_TEST names a test pack this pack refuses:\n  ${refusals.join("\n  ")}`,
    );
  }
};

/** The SHA-1s `security find-identity -v -p codesigning` lists: the identities macOS trusts. */
export const trustedIdentitiesIn = (listed: string) =>
  listed.split("\n").flatMap((line) => {
    const sha1 = /^\s*\d+\) (?<sha1>[0-9A-F]{40}) "/u.exec(line)?.groups?.sha1;

    return sha1 === undefined ? [] : [sha1];
  });

const loopbackBase = (feed: string) => {
  if (!isLoopbackFeed(feed)) {
    throw new Error(offLoopback(feed));
  }

  return new URL(".", feed).href;
};

/**
 * A test pack's `Contents/Resources/app-update.yml`: its loopback feed, in place of the release's
 * GitHub one, which electron-builder writes into a release alone.
 */
export const appUpdateYml = (feed: string) =>
  [
    "provider: generic",
    `url: ${loopbackBase(feed)}`,
    `updaterCacheDirName: ${UPDATER_CACHE}`,
    "",
  ].join("\n");

/** What `latest-mac.yml` says of one zip. */
interface Served {
  feed: string;
  version: string;
  /** The zip's SHA-512, base64, as electron-updater checks a download against. */
  sha512: string;
  size: number;
  releasedAt: Date;
}

/** A test pack's `latest-mac.yml`: a release's, naming the zip served beside it on loopback. */
export const loopbackFeed = ({ feed, releasedAt, sha512, size, version }: Served) => {
  const zip = zipName(version);
  loopbackBase(feed);

  return [
    `version: ${version}`,
    "files:",
    `  - url: ${zip}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${zip}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releasedAt.toISOString()}'`,
    "",
  ].join("\n");
};

/**
 * `file` as the file system resolves it, through every link in it, though it is not there yet.
 * realpath(3), not node's walk, which keeps each part as it was typed: on the Mac's case-blind disk
 * `/Applications` is `/applications`, and realpath(3) answers it as the disk spells it.
 */
export const realPathOf: (file: string) => string = (file) => {
  const absolute = path.resolve(file);

  if (existsSync(absolute)) {
    return realpathSync.native(absolute);
  }

  const parent = path.dirname(absolute);

  return parent === absolute ? absolute : path.join(realPathOf(parent), path.basename(absolute));
};

const fieldIn = (yml: string, field: string) => {
  const value = new RegExp(`^${field}: (?<value>\\S+)$`, "mu").exec(yml)?.groups?.value;

  if (value === undefined) {
    throw new Error(`the feed names no ${field}:\n${yml}`);
  }

  return value;
};

/** The version and zip a `latest-mac.yml` offers. */
export const offeredIn = (yml: string) => ({
  path: fieldIn(yml, "path"),
  version: fieldIn(yml, "version"),
});

/** The feed an `app-update.yml` names. */
export const feedOfAppUpdate = (yml: string) => new URL(FEED_NAME, fieldIn(yml, "url")).href;
