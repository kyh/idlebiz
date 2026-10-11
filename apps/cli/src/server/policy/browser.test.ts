import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PAGE_URLS, livePageOf } from "./browser";
import type { BrowserCli } from "./browser";

/** A window as the page walk reads it; one of another origin throws on `location`. */
interface FakeWindow {
  readonly [index: number]: FakeWindow;
  readonly length: number;
  readonly location: { href: string };
  readonly document?: FakeRoot;
  readonly performance?: {
    getEntriesByType: () => readonly { initiatorType: string; name: string }[];
  };
}

interface FakeRoot {
  /** Every element under it, as `querySelectorAll("*")` returns them. */
  querySelectorAll: () => readonly FakeElement[];
}

interface FakeElement {
  contentWindow: FakeWindow | null;
  shadowRoot: FakeRoot | null;
}

interface FakeParts {
  /** What `window.frames` lists. */
  frames?: FakeWindow[];
  elements?: FakeElement[];
  /** What the page's own script left in `window.length`, if it shadowed it. */
  length?: number;
  /** The URLs its frames were loaded from, as resource timing names them. */
  loaded?: string[];
}

const ownWindow = (href: string, parts: FakeParts = {}): FakeWindow => ({
  ...Object.fromEntries((parts.frames ?? []).entries()),
  document: { querySelectorAll: () => parts.elements ?? [] },
  length: parts.length ?? (parts.frames ?? []).length,
  location: { href },
  performance: {
    getEntriesByType: () => [
      { initiatorType: "script", name: `${href}app.js` },
      ...(parts.loaded ?? []).map((name) => ({ initiatorType: "iframe", name })),
    ],
  },
});

const foreignWindow = (): FakeWindow => ({
  length: 0,
  get location(): never {
    throw new Error("SecurityError: Blocked a frame from accessing a cross-origin frame.");
  },
});

const iframe = (contentWindow: FakeWindow): FakeElement => ({ contentWindow, shadowRoot: null });

const shadowHost = (elements: FakeElement[]): FakeElement => ({
  contentWindow: null,
  shadowRoot: { querySelectorAll: () => elements },
});

const PageUrls = z.array(z.string().nullable());

const pageUrlsOf = (top: FakeWindow): readonly (string | null)[] =>
  PageUrls.parse(runInNewContext(PAGE_URLS, { window: { top } }));

describe("PAGE_URLS", () => {
  it("finds frames in open shadow roots and those a page's own `length` hides", () => {
    const embed = ownWindow("http://localhost:3000/embed");
    const top = ownWindow("http://localhost:3000/", {
      elements: [iframe(embed), shadowHost([iframe(foreignWindow())])],
      length: 0,
    });
    expect(pageUrlsOf(top)).toEqual([
      "http://localhost:3000/",
      "http://localhost:3000/embed",
      null,
    ]);
  });

  it("names a frame no script can reach by the URL it was loaded from", () => {
    const top = ownWindow("http://localhost:3000/", { loaded: ["http://localhost:4000/pay"] });
    expect(pageUrlsOf(top)).toEqual(["http://localhost:3000/", "http://localhost:4000/pay"]);
  });

  it("reads a frame once, however it is reached", () => {
    const embed = ownWindow("http://localhost:3000/embed");
    const top = ownWindow("http://localhost:3000/", {
      elements: [iframe(embed)],
      frames: [embed],
    });
    expect(pageUrlsOf(top)).toEqual(["http://localhost:3000/", "http://localhost:3000/embed"]);
  });
});

/** agent-browser as a daemon that is running or not, on the page `urls` names; what it was asked, in order. */
const browserAt = (running: boolean, urls: readonly (string | null)[]) => {
  const asked: string[][] = [];
  const browser: BrowserCli = (args) => {
    asked.push([...args]);
    const data = args.includes("info") ? { active: running } : { result: urls };
    return Promise.resolve(JSON.stringify({ data, success: true }));
  };
  return { asked, browser };
};

describe("livePageOf", () => {
  it("reads the session in the daemon the runs drive", async () => {
    const { asked, browser } = browserAt(true, ["http://localhost:3000/", null]);
    expect(await livePageOf(browser, "idlebiz-x")("mae")).toEqual({
      frames: [null],
      url: "http://localhost:3000/",
    });
    const scope = ["--namespace", "idlebiz-x", "--session", "mae"];
    expect(asked).toEqual([
      [...scope, "session", "info", "--json"],
      [...scope, "eval", PAGE_URLS, "--json"],
    ]);
  });

  it("starts no daemon: a session with none shows no page", async () => {
    const { asked, browser } = browserAt(false, ["about:blank"]);
    expect(await livePageOf(browser, "idlebiz-x")("")).toBeNull();
    expect(asked).toEqual([["--namespace", "idlebiz-x", "session", "info", "--json"]]);
  });

  it("shows no page when agent-browser cannot answer", async () => {
    expect(await livePageOf(() => Promise.reject(new Error("ENOENT")), "idlebiz-x")("")).toBeNull();
  });
});
