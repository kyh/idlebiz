import { describe, expect, it } from "vitest";
import {
  EXTERNAL_OPEN_SPACING_MS,
  classify,
  comparableOrigin,
  createExternalOpens,
  pageOrigin,
} from "./navigation";

const pinned = "http://127.0.0.1:4664";

describe("the window's pin", () => {
  it("keeps the pinned origin on any path", () => {
    expect(classify("http://127.0.0.1:4664/settings?tab=1", pinned)).toBe("allow");
    expect(classify("http://127.0.0.1:52100/?handoff=n", "http://127.0.0.1:52100")).toBe("allow");
  });

  it("compares origins, not prefixes", () => {
    expect(classify("http://127.0.0.1:46640/", pinned)).toBe("open-externally");
    expect(classify("http://localhost:4664/", pinned)).toBe("open-externally");
    expect(classify("https://127.0.0.1:4664/", pinned)).toBe("open-externally");
  });

  it("takes a login in the url for no origin", () => {
    expect(comparableOrigin(new URL("http://127.0.0.1:4664@evil.example/"))).toBeNull();
    expect(classify("http://127.0.0.1:4664@evil.example/", pinned)).toBe("open-externally");
    expect(classify("http://user@127.0.0.1:4664/", pinned)).toBe("open-externally");
    expect(classify("http://:secret@127.0.0.1:4664/", pinned)).toBe("open-externally");
    expect(classify("file://localhost@evil/", pinned)).toBe("deny");
  });

  it("opens other web pages in the browser and refuses the rest", () => {
    expect(classify("https://example.com/", pinned)).toBe("open-externally");
    expect(classify("file:///etc/passwd", pinned)).toBe("deny");
    // oxlint-disable-next-line no-script-url -- the pin must refuse one
    expect(classify("javascript:alert(1)", pinned)).toBe("deny");
    expect(classify("devtools://devtools/", pinned)).toBe("deny");
    expect(classify("not a url", pinned)).toBe("deny");
  });

  it("leaves the page for no blank document", () => {
    for (const blank of ["about:srcdoc", "about:blank", "about:config"]) {
      expect(classify(blank, pinned)).toBe("deny");
    }
  });
});

describe("main's page", () => {
  it("is plain http on loopback at a port", () => {
    expect(pageOrigin("http://127.0.0.1:52100/?handoff=n")).toBe("http://127.0.0.1:52100");

    for (const refused of [
      "https://127.0.0.1:52100/",
      "http://localhost:52100/",
      "http://127.0.0.1/",
      "http://127.0.0.1:0/",
      "http://example.com:52100/",
      "http://me@127.0.0.1:52100/",
      "file:///",
      "not a url",
    ]) {
      expect(pageOrigin(refused), refused).toBeNull();
    }
  });
});

describe("the browser", () => {
  it("opens at most once a second", () => {
    const opens = createExternalOpens();

    expect(opens.allow(10_000)).toBe(true);
    expect(opens.allow(10_400)).toBe(false);
    expect(opens.allow(10_000 + EXTERNAL_OPEN_SPACING_MS)).toBe(true);
  });
});
