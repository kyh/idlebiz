// A test pack: an ad-hoc pack an update is tested on, which asks a loopback feed and checks what
// it installs against a throwaway key made in scratch. package.ts packs one under
// IDLEBIZ_PACK_UPDATE_TEST=<spec.json>, writing its feed and that key's public half into that
// pack's config alone, so neither sits in tauri.conf.json or reaches what a release is built from.
// Both are set at pack time, never read at runtime: a switch the installed app read could be set
// for every app opened after it by `launchctl setenv`, and would re-point the founder's updates.
// Pure but for `realPathOf`, so a test holds every refusal without a Mac.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FEED_NAME, archiveName, feedFor } from "./release-feed.ts";
import type { Release } from "./release-feed.ts";

const absolutePath = z.string().refine((file) => path.isAbsolute(file), "an absolute path");

const testPack = {
  /** The one feed the pack asks: `http://127.0.0.1:<port>/latest.json`. */
  feed: z.string(),
  /** Where the pack leaves its .app, and its archive and feed. */
  outDir: absolutePath,
  /** The public half of the throwaway key the pack's updates are signed with, checked on each. */
  pubkey: z.string().min(1),
  /** The version the shell and its server name, in place of package.json's. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/u, "a version such as 0.0.11"),
};

/** What IDLEBIZ_PACK_UPDATE_TEST names: one test pack, the update (`archive`) or one it updates. */
export const updateTestSpecSchema = z.discriminatedUnion("archive", [
  z.strictObject({
    /** The pack is the update: it makes its signed archive and the feed naming it. */
    archive: z.literal(true),
    /** The throwaway key, made without a password, that signs the archive at pack time. */
    key: absolutePath,
    ...testPack,
  }),
  z.strictObject({ archive: z.literal(false), ...testPack }),
]);

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
  /** The OS's temporary folder, where a test pack's key and folder lie. */
  scratch: string;
  /** A path as the file system resolves it, through every link in it, as the disk spells it. */
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

// what tauri-plugin-updater reads as a public key or a signature: base64 of a minisign file, whose
// second line (minisign-verify's `decode`) is base64 of two bytes of algorithm, the key's ID, and
// then the key itself, or the signature
const KEY_ID = { end: 10, start: 2 } as const;
const PUBLIC_KEY_BYTES = 42;
const SIGNATURE_BYTES = 74;

/** The second line of a minisign file as the updater decodes it, or null where it reads none. */
const minisignLineOf = (encoded: string, length: number): Buffer | null => {
  const [, line] = Buffer.from(encoded, "base64").toString("utf-8").split("\n");
  if (line === undefined) {
    return null;
  }
  // node's decoder passes over the \r a CRLF file ends the line with, as the updater's `lines` does
  const bytes = Buffer.from(line, "base64");
  return bytes.length === length ? bytes : null;
};

const keyIdOf = (line: Buffer): Buffer => line.subarray(KEY_ID.start, KEY_ID.end);

/**
 * Whether two public keys share their ID or their key: the updater reads only the second line of
 * each, so the release's under another comment is still the release's.
 */
const sharesKey = (one: string, other: string): boolean => {
  const first = minisignLineOf(one, PUBLIC_KEY_BYTES);
  const second = minisignLineOf(other, PUBLIC_KEY_BYTES);
  if (first === null || second === null) {
    return one === other;
  }
  return (
    keyIdOf(first).equals(keyIdOf(second)) ||
    first.subarray(KEY_ID.end).equals(second.subarray(KEY_ID.end))
  );
};

/**
 * Whether an archive's `.sig`, as `tauri build` writes it, is by the key `pubkey` names: the
 * updater checks a signature only against the key whose ID it carries, so one by any other key,
 * however that key's file was reached, installs nowhere that key is trusted.
 */
export const signedBy = (signature: string, pubkey: string): boolean => {
  const signer = minisignLineOf(signature, SIGNATURE_BYTES);
  const key = minisignLineOf(pubkey, PUBLIC_KEY_BYTES);
  return signer !== null && key !== null && keyIdOf(signer).equals(keyIdOf(key));
};

// the update's key: a throwaway one made in scratch, never the release's or one beside it, nor one
// in the checkout
const keyRefusalsOf = (named: string, scratch: string, pack: Pack): [boolean, string][] => {
  const key = pack.real(named);
  // the folder the release's key sits in, by its own path and by where it leads if it is a link,
  // where a copy or a sibling of it would sit too
  const releaseKeys = [
    pack.real(path.dirname(pack.updaterKey)),
    path.dirname(pack.real(pack.updaterKey)),
  ];
  return [
    [!within(scratch, key), `a test pack's key lies in scratch (${scratch}): ${named}`],
    [
      releaseKeys.some((dir) => within(dir, key)),
      `a test pack signs with a throwaway key made in scratch, never one beside ${pack.updaterKey}, the release's: ${named}`,
    ],
    [
      within(pack.real(pack.checkout), key),
      `a test pack's key is never in the checkout, which every run can read: ${named}`,
    ],
  ];
};

const refusalsOf = (spec: UpdateTestSpec, pack: Pack): string[] => {
  const scratch = pack.real(pack.scratch);
  const outDir = pack.real(spec.outDir);
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
    // a test pack that is not the update signs nothing, so it names no key
    ...(spec.archive ? keyRefusalsOf(spec.key, scratch, pack) : []),
    [
      sharesKey(spec.pubkey, pack.pubkey),
      "a test pack's pubkey is a throwaway key's, never tauri.conf.json's however it is encoded, which every install checks its updates against",
    ],
    [
      !within(scratch, outDir),
      `a test pack's folder lies in scratch (${scratch}), never where an installed app is: ${spec.outDir}`,
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
 * installed app: a release, a signed pack, a feed off loopback, a key or folder outside scratch,
 * the release's key or one where runs read it, the release's pubkey, or the folder a release is
 * published from.
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

/**
 * `file` as the file system resolves it, through every link in it, though it is not there yet.
 * realpath(3), not node's walk, which keeps each part as it was typed: on the Mac's case-blind disk
 * `~/.Tauri` is `~/.tauri`, and realpath(3) answers it as the disk spells it.
 */
export const realPathOf = (file: string): string => {
  const absolute = path.resolve(file);
  if (existsSync(absolute)) {
    return realpathSync.native(absolute);
  }
  const parent = path.dirname(absolute);
  return parent === absolute ? absolute : path.join(realPathOf(parent), path.basename(absolute));
};
