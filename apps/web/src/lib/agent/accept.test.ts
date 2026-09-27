import { describe, expect, it } from "vitest";

import { negotiateMediaType, notAcceptableBody, withVaryAccept } from "./accept";

describe("negotiateMediaType", () => {
  it("defaults to HTML when the client states no constraint", () => {
    for (const header of [null, "", "   ", "*/*", "garbage-without-a-slash"]) {
      expect(negotiateMediaType(header)).toBe("text/html");
    }
  });

  it("serves Markdown when the client asks for it", () => {
    for (const header of [
      "text/markdown",
      "text/markdown, text/html",
      "TEXT/MARKDOWN",
      "text/markdown;charset=utf-8",
    ]) {
      expect(negotiateMediaType(header)).toBe("text/markdown");
    }
  });

  it("serves HTML to a browser's Accept header", () => {
    const browser =
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
    expect(negotiateMediaType(browser)).toBe("text/html");
  });

  it("ranks by q-value, then by the client's order", () => {
    expect(negotiateMediaType("text/html;q=0.5, text/markdown;q=0.9")).toBe("text/markdown");
    expect(negotiateMediaType("text/markdown;q=0.2, text/html;q=0.8")).toBe("text/html");
    expect(negotiateMediaType("text/html, text/markdown")).toBe("text/html");
  });

  it("never lets a wildcard resurrect a type rejected with q=0", () => {
    expect(negotiateMediaType("text/html;q=0, */*")).toBe("text/markdown");
    expect(negotiateMediaType("text/markdown;q=0, */*;q=1")).toBe("text/html");
    expect(negotiateMediaType("text/html;q=0, text/*")).toBe("text/markdown");
  });

  it("returns null only when nothing produced is acceptable", () => {
    expect(negotiateMediaType("application/pdf")).toBeNull();
    expect(negotiateMediaType("text/html;q=0, text/markdown;q=0")).toBeNull();
    expect(negotiateMediaType("*/*;q=0")).toBeNull();
  });
});

describe("withVaryAccept", () => {
  it("adds Accept to an empty Vary", () => {
    expect(withVaryAccept(null)).toBe("Accept");
    expect(withVaryAccept("")).toBe("Accept");
  });

  it("keeps Next's RSC tokens", () => {
    expect(withVaryAccept("rsc, next-router-state-tree")).toBe(
      "rsc, next-router-state-tree, Accept",
    );
  });

  it("does not duplicate Accept, whatever its casing", () => {
    expect(withVaryAccept("accept, rsc")).toBe("accept, rsc");
  });
});

describe("notAcceptableBody", () => {
  it("lists what is available and echoes the request", () => {
    const body = notAcceptableBody("application/pdf");
    expect(body).toContain("- text/html");
    expect(body).toContain("- text/markdown");
    expect(body).toContain("You requested: application/pdf");
    expect(notAcceptableBody(null)).toContain("(no Accept header)");
  });
});
