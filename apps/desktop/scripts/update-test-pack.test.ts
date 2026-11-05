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

// a stand-in for a throwaway key's public half: nothing is generated, and nothing signs with it
const THROWAWAY_PUBKEY = "the throwaway key's public half";
const FEED = `http://127.0.0.1:43123/${FEED_NAME}`;

// a Mac's paths, made up: no test reads the founder's home or a key
const checkout = "/work/idlebiz";
const context = {
  checkout,
  identity: "-",
  pubkey: "the release key's public half",
  real: (file: string): string => path.resolve(file),
  release: false,
  releaseOut: path.join(checkout, "apps", "desktop", ".output", "bin"),
  updaterKey: "/home/founder/.tauri/idlebiz.key",
};

const spec = updateTestSpecSchema.parse({
  archive: true,
  feed: FEED,
  key: "/scratch/update-test/a.key",
  outDir: "/scratch/update-test/next",
  pubkey: THROWAWAY_PUBKEY,
  version: "0.0.11",
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
    ["the release's pubkey", { pubkey: context.pubkey }, {}, "never tauri.conf.json's"],
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
