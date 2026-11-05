// A test pack: an ad-hoc pack an update is tested on, which asks a loopback feed and checks what
// it installs against a throwaway key made in scratch. package.ts packs one under
// IDLEBIZ_PACK_UPDATE_TEST=<spec.json>, writing its feed and key into that pack's config alone, so
// neither sits in tauri.conf.json or reaches what a release is built from. Both are set at pack
// time, never read at runtime: a switch the installed app read could be set for every app opened
// after it by `launchctl setenv`, and would re-point the founder's updates. Pure but for
// `realPathOf`, so a test holds every refusal without a Mac.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FEED_NAME, archiveName, feedFor } from "./release-feed.ts";
import type { Release } from "./release-feed.ts";

const absolutePath = z.string().refine((file) => path.isAbsolute(file), "an absolute path");

/** What IDLEBIZ_PACK_UPDATE_TEST names: one test pack. */
export const updateTestSpecSchema = z.strictObject({
  /** Whether the pack is the update: it makes its signed archive and the feed naming it. */
  archive: z.boolean(),
  /** The one feed the pack asks: `http://127.0.0.1:<port>/latest.json`. */
  feed: z.string(),
  /** The throwaway key, made without a password, that signs the archive. */
  key: absolutePath,
  /** Where the pack leaves its .app, and its archive and feed. */
  outDir: absolutePath,
  /** `key`'s public half, which the pack checks every update against. */
  pubkey: z.string().min(1),
  /** The version the shell and its server name, in place of package.json's. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/u, "a version such as 0.0.11"),
});

type UpdateTestSpec = z.infer<typeof updateTestSpecSchema>;

/** The pack a spec would change, as package.ts knows it. */
interface Pack {
  /** Whether the pack is a release (`IDLEBIZ_RELEASE=1`). */
  release: boolean;
  /** The identity the pack signs as: `-` for ad-hoc. */
  identity: string;
  /** The key that signs each release's archive (package.ts's `UPDATER_KEY`). */
  updaterKey: string;
  /** tauri.conf.json's `plugins.updater.pubkey`: that key's public half. */
  pubkey: string;
  /** The checkout, which every run can read. */
  checkout: string;
  /** Where a release leaves its assets, which publish-release.sh uploads. */
  releaseOut: string;
  /** A path as the file system resolves it, through every link in it. */
  real: (file: string) => string;
}

/** Whether `feed` is a latest.json on loopback, at an explicit port: this Mac alone answers it. */
const isLoopbackFeed = (feed: string): boolean => {
  const port = /^http:\/\/127\.0\.0\.1:(?<port>[1-9]\d{0,4})\//u.exec(feed)?.groups?.port;
  return (
    port !== undefined && Number(port) <= 65_535 && feed === `http://127.0.0.1:${port}/${FEED_NAME}`
  );
};

const offLoopback = (feed: string): string =>
  `a test pack's feed is http://127.0.0.1:<port>/${FEED_NAME}, which this Mac alone answers, not ${feed}`;

/** Whether `file` is `dir` or lies inside it. */
const within = (dir: string, file: string): boolean => {
  const relative = path.relative(dir, file);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

const refusalsOf = (spec: UpdateTestSpec, pack: Pack): string[] => {
  const key = pack.real(spec.key);
  // the folder the release's key sits in, where a copy or a sibling of it would sit too
  const releaseKeys = path.dirname(pack.real(pack.updaterKey));
  const rules: [refused: boolean, refusal: string][] = [
    [
      pack.release,
      "a test pack is never a release: its feed and key are ones no installed app may take, so unset IDLEBIZ_PACK_UPDATE_TEST or IDLEBIZ_RELEASE",
    ],
    [
      pack.identity !== "-",
      `a test pack is ad-hoc (IDLEBIZ_PACK_UNSIGNED=1), so it opens on this Mac alone, never signed as ${pack.identity}`,
    ],
    [!isLoopbackFeed(spec.feed), offLoopback(spec.feed)],
    [
      within(releaseKeys, key),
      `a test pack signs with a throwaway key made in scratch, never one in ${releaseKeys}, where the release's is: ${spec.key}`,
    ],
    [
      within(pack.real(pack.checkout), key),
      `a test pack's key is never in the checkout, which every run can read: ${spec.key}`,
    ],
    [
      spec.pubkey === pack.pubkey,
      "a test pack's pubkey is its throwaway key's, never tauri.conf.json's, which every install checks its updates against",
    ],
    [
      within(pack.real(pack.releaseOut), pack.real(spec.outDir)),
      `a test pack never leaves anything in ${pack.releaseOut}, which publishing uploads: ${spec.outDir}`,
    ],
  ];
  return rules.flatMap(([refused, refusal]) => (refused ? [refusal] : []));
};

/**
 * Throws, naming each, while `spec` is a test pack that could reach a release or another Mac: a
 * release, a signed pack, a feed off loopback, the release's key or one where runs read it, the
 * release's pubkey, or the folder a release is published from.
 */
export const refuseUpdateTest = (spec: UpdateTestSpec, pack: Pack): void => {
  const refusals = refusalsOf(spec, pack);
  if (refusals.length > 0) {
    throw new Error(
      `IDLEBIZ_PACK_UPDATE_TEST names a test pack this pack refuses:\n  ${refusals.join("\n  ")}`,
    );
  }
};

/**
 * What a test pack sets in its pack's config, and nothing without one: its version, and its feed
 * and pubkey in place of tauri.conf.json's. A release build of tauri-plugin-updater refuses an
 * http endpoint unless `dangerousInsecureTransportProtocol` allows one, and a loopback feed, which
 * never leaves this Mac, is the only one it is set for.
 */
export const updateTestConfig = (spec: UpdateTestSpec | null) => {
  if (spec === null) {
    return {};
  }
  if (!isLoopbackFeed(spec.feed)) {
    throw new Error(offLoopback(spec.feed));
  }
  return {
    plugins: {
      updater: {
        dangerousInsecureTransportProtocol: true,
        endpoints: [spec.feed],
        pubkey: spec.pubkey,
      },
    },
    version: spec.version,
  };
};

/** A test pack's feed: a release's, naming the archive served beside it on loopback. */
export const loopbackFeed = ({ feed, ...signed }: Release) => {
  if (!isLoopbackFeed(feed)) {
    throw new Error(offLoopback(feed));
  }
  return feedFor({ ...signed, archiveUrl: new URL(archiveName(signed.version), feed).href });
};

/** `file` as the file system resolves it, through every link in it, though it is not there yet. */
export const realPathOf = (file: string): string => {
  const absolute = path.resolve(file);
  if (existsSync(absolute)) {
    return realpathSync(absolute);
  }
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(realPathOf(parent), path.basename(absolute));
};
