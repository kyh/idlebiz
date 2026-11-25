import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FEED_NAME,
  appUpdateYml,
  feedOfAppUpdate,
  loopbackFeed,
  offeredIn,
  realPathOf,
  refuseUpdateTest,
  trustedIdentitiesIn,
  updateTestSpecSchema,
} from "./update-test-pack.ts";

const FEED = `http://127.0.0.1:43123/${FEED_NAME}`;
const THROWAWAY = "A".repeat(40);
const DEVELOPER_ID = "B".repeat(40);

const checkout = "/work/idlebiz";

const context = {
  checkout,
  installed: ["/Applications", "/home/founder/Applications"],
  real: (file: string) => path.resolve(file),
  release: false,
  releaseOut: path.join(checkout, "apps", "desktop", ".output", "bin"),
  scratch: "/scratch",
  trusted: [DEVELOPER_ID],
};

const through = (from: string, to: string) => (file: string) => {
  const relative = path.relative(from, file);

  return relative.startsWith("..") ? path.resolve(file) : path.join(to, relative);
};

const spec = updateTestSpecSchema.parse({
  archive: true,
  feed: FEED,
  identity: THROWAWAY,
  keychain: "/scratch/update-test/signing.keychain-db",
  outDir: "/scratch/update-test/next",
  root: "/scratch/save",
  version: "0.0.11",
});

const OFF_LOOPBACK = [
  "https://github.com/kyh/idlebiz/releases/latest/download/latest-mac.yml",
  `https://127.0.0.1:43123/${FEED_NAME}`,
  `http://localhost:43123/${FEED_NAME}`,
  `http://10.0.0.2:43123/${FEED_NAME}`,
  `http://127.0.0.1/${FEED_NAME}`,
  `http://127.0.0.1:0/${FEED_NAME}`,
  `http://127.0.0.1:65536/${FEED_NAME}`,
  "http://127.0.0.1:43123/latest.yml",
  `http://127.0.0.1:43123/${FEED_NAME}?v=1`,
  `http://founder@127.0.0.1:43123/${FEED_NAME}`,
  `http://127.0.0.1:43123.example.com/${FEED_NAME}`,
];

describe("a test pack's spec", () => {
  it("is refused nothing on a loopback feed, an untrusted identity and scratch", () => {
    expect(() => {
      refuseUpdateTest(spec, context);
    }).not.toThrow();
  });

  it("takes scratch as the file system resolves it", () => {
    const linked = { ...context, real: through("/tmp", "/private/tmp"), scratch: "/tmp" };
    expect(() => {
      refuseUpdateTest(
        { ...spec, keychain: "/tmp/k.keychain-db", outDir: "/tmp/next", root: "/tmp/save" },
        linked,
      );
    }).not.toThrow();
  });

  it.each([
    ["a release", {}, { release: true }, "a test pack is never a release"],
    ["an identity macOS trusts", { identity: DEVELOPER_ID }, {}, "a throwaway identity"],
    [
      "a keychain outside scratch",
      { keychain: "/Users/kai/Library/Keychains/login.keychain-db" },
      {},
      "a test pack's keychain lies in scratch",
    ],
    [
      "a keychain in the checkout",
      { keychain: path.join(checkout, "signing.keychain-db") },
      { scratch: "/work" },
      "keychain is never in the checkout",
    ],
    ["a save outside scratch", { root: "/Users/kai/.idlebiz" }, {}, "save lies in scratch"],
    [
      "a save in the checkout",
      { root: path.join(checkout, "save") },
      { scratch: "/work" },
      "save is never in the checkout",
    ],
    [
      "a folder outside scratch, where the app is installed",
      { outDir: "/Applications" },
      {},
      "a test pack's folder lies in scratch",
    ],
    [
      "where apps are installed, though scratch is set to it",
      { outDir: "/Applications" },
      { scratch: "/Applications" },
      "never leaves anything where apps are installed",
    ],
    [
      "the founder's own Applications, though scratch is above it",
      { outDir: "/home/founder/Applications/next" },
      { scratch: "/home" },
      "never leaves anything where apps are installed",
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

  it("refuses a folder that is the release's through a link", () => {
    const link = "/scratch/update-test/linked-out";
    expect(() => {
      refuseUpdateTest(
        { ...spec, outDir: link },
        { ...context, real: through(link, context.releaseOut) },
      );
    }).toThrow("which publishing uploads");
  });

  it("refuses a keychain in a checkout reached through a link", () => {
    const linked = {
      ...context,
      checkout: "/scratch/linked",
      real: through("/scratch/linked", "/scratch/checkout"),
    };

    expect(() => {
      refuseUpdateTest({ ...spec, keychain: "/scratch/checkout/k.keychain-db" }, linked);
    }).toThrow("keychain is never in the checkout");
  });

  it("names every refusal at once", () => {
    expect(() => {
      refuseUpdateTest({ ...spec, outDir: context.releaseOut }, { ...context, release: true });
    }).toThrow(/never a release[\s\S]*which publishing uploads/u);
  });

  it.each([
    ["an unknown key", { ...spec, endpoint: FEED }],
    ["a relative keychain", { ...spec, keychain: "k.keychain-db" }],
    ["a relative save", { ...spec, root: "save" }],
    ["a relative folder", { ...spec, outDir: "next" }],
    ["an identity by name", { ...spec, identity: "IdleBiz Test A" }],
    ["an identity in lower case", { ...spec, identity: "a".repeat(40) }],
    ["a version that names a path", { ...spec, version: "0.0.11/../../bin" }],
    ["no archive choice", { ...spec, archive: undefined }],
  ])("is strict: refuses %s", (_what, value) => {
    expect(updateTestSpecSchema.safeParse(value).success).toBe(false);
  });
});

describe("the identities macOS trusts", () => {
  it("are the SHA-1s find-identity lists as valid", () => {
    const listed = [
      "Policy: Code Signing",
      "  Matching identities",
      `  1) ${DEVELOPER_ID} "Developer ID Application: Kai (TEAM123)"`,
      "     1 identities found",
      "",
      "  Valid identities only",
      `  1) ${DEVELOPER_ID} "Developer ID Application: Kai (TEAM123)"`,
      "     1 valid identities found",
    ].join("\n");

    expect(trustedIdentitiesIn(listed)).toEqual([DEVELOPER_ID, DEVELOPER_ID]);
    expect(trustedIdentitiesIn("     0 valid identities found\n")).toEqual([]);
  });
});

describe("the loopback feed", () => {
  it("is the folder of the feed, read by electron-updater's generic provider", () => {
    expect(appUpdateYml(FEED)).toBe(
      "provider: generic\nurl: http://127.0.0.1:43123/\nupdaterCacheDirName: idlebiz-updater\n",
    );
  });

  it("names the zip beside it, with its digest and size", () => {
    expect(
      loopbackFeed({
        feed: FEED,
        releasedAt: new Date("2026-11-05T10:00:00Z"),
        sha512: "c2hhNTEy",
        size: 1234,
        version: "0.0.11",
      }),
    ).toBe(
      [
        "version: 0.0.11",
        "files:",
        "  - url: IdleBiz-0.0.11-arm64-mac.zip",
        "    sha512: c2hhNTEy",
        "    size: 1234",
        "path: IdleBiz-0.0.11-arm64-mac.zip",
        "sha512: c2hhNTEy",
        "releaseDate: '2026-11-05T10:00:00.000Z'",
        "",
      ].join("\n"),
    );
  });

  it("reads back as the feed and the offer the smoke checks", () => {
    expect(feedOfAppUpdate(appUpdateYml(FEED))).toBe(FEED);
    expect(
      offeredIn(
        loopbackFeed({
          feed: FEED,
          releasedAt: new Date(),
          sha512: "x",
          size: 1,
          version: "0.0.11",
        }),
      ),
    ).toEqual({ path: "IdleBiz-0.0.11-arm64-mac.zip", version: "0.0.11" });
    expect(() => offeredIn("files: []\n")).toThrow("the feed names no path");
  });

  it.each(OFF_LOOPBACK)("refuses a feed off loopback: %s", (feed) => {
    expect(() => appUpdateYml(feed)).toThrow(
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
