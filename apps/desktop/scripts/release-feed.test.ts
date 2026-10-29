import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJson } from "@repo/domain/json";
import { FEED_NAME, archiveName, releaseAssets, releaseFeed } from "./release-feed.ts";

const desktop = path.resolve(import.meta.dirname, "..");

// the feed the installed app asks, as the shell is built with it
const [endpoint] = z
  .object({
    plugins: z.object({ updater: z.object({ endpoints: z.tuple([z.string()]) }) }),
  })
  .parse(parseJson(readFileSync(path.join(desktop, "src-tauri", "tauri.conf.json"), "utf-8")))
  .plugins.updater.endpoints;

describe("the release feed", () => {
  it("is the latest release's latest.json, which publishing makes the latest last", () => {
    expect(endpoint).toBe(`https://github.com/kyh/idlebiz/releases/latest/download/${FEED_NAME}`);
  });

  it("names the archive in the release it ships with, signed", () => {
    const feed = releaseFeed({
      feed: endpoint,
      publishedAt: new Date("2026-11-02T09:30:00Z"),
      signature: "untrusted comment: signature from tauri secret key\nRWQ…\n",
      version: "0.4.0",
    });
    expect(feed).toEqual({
      platforms: {
        "darwin-aarch64": {
          signature: "untrusted comment: signature from tauri secret key\nRWQ…",
          url: "https://github.com/kyh/idlebiz/releases/download/v0.4.0/IdleBiz-0.4.0-arm64.app.tar.gz",
        },
      },
      pub_date: "2026-11-02T09:30:00.000Z",
      version: "0.4.0",
    });
  });

  it("refuses a feed that is no GitHub release's latest.json", () => {
    expect(() => releaseAssets("https://example.com/idlebiz/latest.json", "0.4.0")).toThrow(
      "is no GitHub release's latest.json",
    );
  });

  // a renamed asset on either side would publish a feed whose URL answers 404
  it("names what publishing uploads", () => {
    const publish = readFileSync(path.join(desktop, "scripts", "publish-release.sh"), "utf-8");
    // oxlint-disable-next-line no-template-curly-in-string -- the script's own shell variable, verbatim
    expect(publish).toContain(`.output/bin/${archiveName("${VERSION}")}`);
    expect(publish).toContain(`.output/bin/${FEED_NAME}`);
  });
});
