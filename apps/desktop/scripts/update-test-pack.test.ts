import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJson } from "@repo/domain/json";
import { FEED_NAME, releaseFeed } from "./release-feed.ts";
import {
  loopbackFeed,
  realPathOf,
  refuseUpdateTest,
  signedBy,
  updateTestConfig,
  updateTestSpecSchema,
} from "./update-test-pack.ts";

const desktop = path.resolve(import.meta.dirname, "..");

// the shell's updater as tauri.conf.json builds every release with it
const { updater } = z
  .object({ plugins: z.object({ updater: z.record(z.string(), z.unknown()) }) })
  .parse(
    parseJson(readFileSync(path.join(desktop, "src-tauri", "tauri.conf.json"), "utf-8")),
  ).plugins;
const [endpoint] = z.object({ endpoints: z.tuple([z.string()]) }).parse(updater).endpoints;

// a minisign file as tauri writes a public key or a signature: base64 of lines whose second is
// base64 of "Ed", the key's ID and then the key or the signature
const minisign = (...lines: string[]): string =>
  Buffer.from(`${lines.join("\n")}\n`).toString("base64");
const ED25519 = Buffer.from("Ed");

// stand-ins for public halves, each byte of the ID and the key one number: nothing is generated,
// and nothing signs with them
const pubkeyOf = (id: number, key: number, comment = "minisign public key"): string =>
  minisign(
    `untrusted comment: ${comment}`,
    Buffer.concat([ED25519, Buffer.alloc(8, id), Buffer.alloc(32, key)]).toString("base64"),
  );
// a stand-in for an archive's .sig, carrying the ID of the key it names as its signer
const signatureOf = (id: number): string =>
  minisign(
    "untrusted comment: signature from tauri secret key",
    Buffer.concat([ED25519, Buffer.alloc(8, id), Buffer.alloc(64, 9)]).toString("base64"),
    "trusted comment: timestamp:1793872800\tfile:IdleBiz.app.tar.gz",
    Buffer.alloc(64, 9).toString("base64"),
  );

const RELEASE_PUBKEY = pubkeyOf(1, 1);
const THROWAWAY_PUBKEY = pubkeyOf(2, 2);
const FEED = `http://127.0.0.1:43123/${FEED_NAME}`;

// a Mac's paths, made up: no test reads the founder's home or a key
const checkout = "/work/idlebiz";
const context = {
  checkout,
  identity: "-",
  pubkey: RELEASE_PUBKEY,
  real: (file: string): string => path.resolve(file),
  release: false,
  releaseOut: path.join(checkout, "apps", "desktop", ".output", "bin"),
  scratch: "/scratch",
  updaterKey: "/home/founder/.tauri/idlebiz.key",
};

// a resolver through one link, `from` naming `to`, as realPathOf answers on a Mac
const through =
  (from: string, to: string) =>
  (file: string): string => {
    const relative = path.relative(from, file);
    return relative.startsWith("..") ? path.resolve(file) : path.join(to, relative);
  };

// the update, which names its key
const [updateSchema] = updateTestSpecSchema.options;
const spec = updateSchema.parse({
  archive: true,
  feed: FEED,
  key: "/scratch/update-test/a.key",
  outDir: "/scratch/update-test/next",
  pubkey: THROWAWAY_PUBKEY,
  version: "0.0.11",
});

// the pack an update is tested from, which signs nothing
const updated = updateTestSpecSchema.parse({
  archive: false,
  feed: FEED,
  outDir: "/scratch/update-test/installed",
  pubkey: THROWAWAY_PUBKEY,
  version: "0.0.10",
});

// every feed but a loopback one's latest.json on an explicit port
const OFF_LOOPBACK = [
  endpoint,
  `https://127.0.0.1:43123/${FEED_NAME}`,
  `http://localhost:43123/${FEED_NAME}`,
  `http://10.0.0.2:43123/${FEED_NAME}`,
  `http://127.0.0.1/${FEED_NAME}`,
  `http://127.0.0.1:0/${FEED_NAME}`,
  `http://127.0.0.1:65536/${FEED_NAME}`,
  "http://127.0.0.1:43123/feed.json",
  `http://127.0.0.1:43123/${FEED_NAME}?v=1`,
  `http://founder@127.0.0.1:43123/${FEED_NAME}`,
  `http://127.0.0.1:43123.example.com/${FEED_NAME}`,
];

describe("a test pack's spec", () => {
  it("is refused nothing on a loopback feed, a throwaway key in scratch and an ad-hoc identity", () => {
    expect(() => {
      refuseUpdateTest(spec, context);
    }).not.toThrow();
  });

  it("names no key when the pack is not the update, and is refused nothing", () => {
    expect(() => {
      refuseUpdateTest(updated, context);
    }).not.toThrow();
  });

  it("takes scratch as the file system resolves it", () => {
    const linked = { ...context, real: through("/tmp", "/private/tmp"), scratch: "/tmp" };
    expect(() => {
      refuseUpdateTest({ ...spec, key: "/tmp/a.key", outDir: "/tmp/next" }, linked);
    }).not.toThrow();
  });

  it.each([
    ["a release", {}, { release: true }, "a test pack is never a release"],
    [
      "a Developer ID",
      {},
      { identity: "Developer ID Application: Kai (TEAM123)" },
      "a test pack is ad-hoc",
    ],
    ["the release's key", { key: context.updaterKey }, {}, "a throwaway key made in scratch"],
    [
      "a key beside the release's",
      { key: "/home/founder/.tauri/test.key" },
      {},
      "a throwaway key made in scratch",
    ],
    [
      "a key in the checkout",
      { key: path.join(checkout, "apps", "desktop", "update-test.key") },
      {},
      "never in the checkout",
    ],
    [
      "a key outside scratch",
      { key: "/Users/kai/keys/a.key" },
      {},
      "a test pack's key lies in scratch",
    ],
    [
      "the release's key spelled in another case, unresolved",
      { key: "/home/founder/.Tauri/idlebiz.key" },
      {},
      "a test pack's key lies in scratch",
    ],
    ["the release's pubkey", { pubkey: context.pubkey }, {}, "never tauri.conf.json's"],
    [
      "the release's pubkey where no updater reads it as one",
      { pubkey: "the release key's public half" },
      { pubkey: "the release key's public half" },
      "never tauri.conf.json's",
    ],
    [
      "the release's pubkey under another comment",
      { pubkey: pubkeyOf(1, 1, "rsign public key: 0101010101010101") },
      {},
      "never tauri.conf.json's",
    ],
    [
      "a pubkey with the release key's ID",
      { pubkey: pubkeyOf(1, 3) },
      {},
      "never tauri.conf.json's",
    ],
    [
      "the release's key under another ID",
      { pubkey: pubkeyOf(3, 1) },
      {},
      "never tauri.conf.json's",
    ],
    [
      "a folder outside scratch, where the app is installed",
      { outDir: "/Applications" },
      {},
      "a test pack's folder lies in scratch",
    ],
    ["the release's folder", { outDir: context.releaseOut }, {}, "which publishing uploads"],
    [
      "a folder inside the release's",
      { outDir: path.join(context.releaseOut, "next") },
      {},
      "which publishing uploads",
    ],
  ])("refuses %s", (_what, specChange, contextChange, refusal) => {
    expect(() => {
      refuseUpdateTest({ ...spec, ...specChange }, { ...context, ...contextChange });
    }).toThrow(refusal);
  });

  it.each(OFF_LOOPBACK)("refuses the feed %s", (feed) => {
    expect(() => {
      refuseUpdateTest({ ...spec, feed }, context);
    }).toThrow(`a test pack's feed is http://127.0.0.1:<port>/${FEED_NAME}`);
  });

  it("refuses a key that is the release's through a link", () => {
    const link = "/scratch/update-test/linked.key";
    const real = (file: string): string => (file === link ? context.updaterKey : file);
    expect(() => {
      refuseUpdateTest({ ...spec, key: link }, { ...context, real });
    }).toThrow("a throwaway key made in scratch");
  });

  // the release's key a link elsewhere: a key beside the link and one beside its target
  it.each(["/home/founder/.tauri/test.key", "/Volumes/Keys/test.key"])(
    "refuses %s, beside the release's key or the file it links to",
    (key) => {
      const real = through(context.updaterKey, "/Volumes/Keys/idlebiz.key");
      expect(() => {
        refuseUpdateTest({ ...spec, key }, { ...context, real });
      }).toThrow("a throwaway key made in scratch");
    },
  );

  it("refuses a key in a checkout reached through a link", () => {
    const linked = {
      ...context,
      checkout: "/work/linked",
      real: through("/work/linked", checkout),
    };
    expect(() => {
      refuseUpdateTest({ ...spec, key: path.join(checkout, "a.key") }, linked);
    }).toThrow("never in the checkout");
  });

  it("refuses a folder that is the release's through a link", () => {
    const link = "/scratch/update-test/linked-out";
    expect(() => {
      refuseUpdateTest(
        { ...spec, outDir: link },
        { ...context, real: through(link, context.releaseOut) },
      );
    }).toThrow("which publishing uploads");
  });

  it("refuses a folder inside a release folder reached through a link", () => {
    const linked = {
      ...context,
      real: through("/work/linked-bin", context.releaseOut),
      releaseOut: "/work/linked-bin",
    };
    expect(() => {
      refuseUpdateTest({ ...spec, outDir: path.join(context.releaseOut, "next") }, linked);
    }).toThrow("which publishing uploads");
  });

  it("names every refusal at once", () => {
    expect(() => {
      refuseUpdateTest({ ...spec, outDir: context.releaseOut }, { ...context, release: true });
    }).toThrow(/never a release[\s\S]*which publishing uploads/u);
  });

  it.each([
    ["an unknown key", { ...spec, endpoint: FEED }],
    ["a relative key", { ...spec, key: "a.key" }],
    ["a relative folder", { ...spec, outDir: "next" }],
    ["an empty pubkey", { ...spec, pubkey: "" }],
    ["a version that names a path", { ...spec, version: "0.0.11/../../bin" }],
    ["no archive choice", { ...spec, archive: undefined }],
    ["no key on the update", { ...updated, archive: true }],
    ["a key on a pack that is not the update", { ...spec, archive: false }],
  ])("is strict: refuses %s", (_what, value) => {
    expect(updateTestSpecSchema.safeParse(value).success).toBe(false);
  });
});

describe("a test pack's config", () => {
  it("takes its version, and only its loopback feed and its own pubkey, http allowed", () => {
    expect(updateTestConfig(spec)).toEqual({
      plugins: {
        updater: {
          dangerousInsecureTransportProtocol: true,
          endpoints: [FEED],
          pubkey: THROWAWAY_PUBKEY,
        },
      },
      version: "0.0.11",
    });
  });

  it.each(OFF_LOOPBACK)("allows http for no feed off loopback: %s", (feed) => {
    expect(() => updateTestConfig({ ...spec, feed })).toThrow(
      `a test pack's feed is http://127.0.0.1:<port>/${FEED_NAME}`,
    );
  });

  it("adds no plugins and no version to a pack with no spec", () => {
    expect(updateTestConfig(null)).toEqual({});
  });

  // what every release is built from: a dangerous* key here would ship to every install
  it("leaves tauri.conf.json's updater an endpoint and a pubkey, and nothing else", () => {
    expect(Object.keys(updater).toSorted()).toEqual(["endpoints", "pubkey"]);
  });
});

describe("the loopback feed", () => {
  const signed = {
    publishedAt: new Date("2026-11-05T10:00:00Z"),
    signature: "untrusted comment: signature from tauri secret key\nRWQ…\n",
    version: "0.0.11",
  };

  it("has the release feed's shape, naming the archive beside it on loopback", () => {
    const release = releaseFeed({ ...signed, feed: endpoint });
    expect(loopbackFeed({ ...signed, feed: FEED })).toEqual({
      ...release,
      platforms: {
        "darwin-aarch64": {
          ...release.platforms["darwin-aarch64"],
          url: "http://127.0.0.1:43123/IdleBiz-0.0.11-arm64.app.tar.gz",
        },
      },
    });
  });

  it("refuses a feed off loopback", () => {
    expect(() => loopbackFeed({ ...signed, feed: endpoint })).toThrow(
      `a test pack's feed is http://127.0.0.1:<port>/${FEED_NAME}`,
    );
  });
});

describe("an archive's signature", () => {
  it("is by the release's key while it carries that key's ID", () => {
    expect(signedBy(signatureOf(1), RELEASE_PUBKEY)).toBe(true);
    expect(signedBy(signatureOf(1), pubkeyOf(1, 1, "another comment"))).toBe(true);
  });

  it("is by no other key", () => {
    expect(signedBy(signatureOf(2), RELEASE_PUBKEY)).toBe(false);
  });

  it("is by no key while tauri.conf.json names none, or either is one no updater reads", () => {
    expect(signedBy(signatureOf(1), "")).toBe(false);
    const unread = minisign("untrusted comment: cut short", "AAAA");
    expect(signedBy(unread, unread)).toBe(false);
  });
});

describe("realPathOf", () => {
  let scratch: string | null = null;

  afterEach(async () => {
    if (scratch !== null) {
      await rm(scratch, { force: true, recursive: true });
      scratch = null;
    }
  });

  it("resolves the links on the way to a file that is not there yet", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "idlebiz-update-test-"));
    const target = path.join(scratch, "target");
    await mkdir(target);
    await symlink(target, path.join(scratch, "link"));
    expect(realPathOf(path.join(scratch, "link", "out", "IdleBiz.app"))).toBe(
      path.join(await realpath(target), "out", "IdleBiz.app"),
    );
  });
});
