import { describe, expect, it } from "vitest";

import {
  renderHomeMarkdown,
  renderLlmsTxt,
  renderNotFoundMarkdown,
  renderProsePageMarkdown,
} from "./markdown";
import { privacyPage, prosePages } from "./site-content";

const h2Sections = (markdown: string): string[] =>
  markdown.split("\n").filter((line) => line.startsWith("## "));

describe("renderLlmsTxt", () => {
  const llms = renderLlmsTxt();

  it("follows the llmstxt.org shape: H1, then a blockquote summary", () => {
    const [h1, blank, summary] = llms.split("\n");
    expect(h1).toBe("# IdleBiz");
    expect(blank).toBe("");
    expect(summary?.startsWith("> ")).toBe(true);
  });

  it("carries when-to-use guidance before the link sections", () => {
    const guidance = llms.indexOf("**When to use IdleBiz:**");
    expect(guidance).toBeGreaterThan(0);
    expect(guidance).toBeLessThan(llms.indexOf("## "));
  });

  it("links every page with an absolute URL", () => {
    for (const page of prosePages) {
      expect(llms).toContain(`(https://idlebiz.com${page.path})`);
    }
    expect(llms).not.toMatch(/\]\(\//u);
  });

  it("says the release runs only on Apple silicon, since every .dmg is arm64", () => {
    expect(llms).toMatch(/\*\*Requirements\*\*: an Apple silicon Mac/u);
    expect(llms).toMatch(/\*\*Not a fit\*\*: Intel Macs/u);
  });
});

describe("renderHomeMarkdown", () => {
  it("is the same pitch and guidance as the page, with the download", () => {
    const home = renderHomeMarkdown();
    expect(home.startsWith("# IdleBiz\n")).toBe(true);
    expect(h2Sections(home)).toEqual(["## When to use IdleBiz", "## Get started", "## Pages"]);
    expect(home).toContain("https://github.com/kyh/idlebiz/releases/latest");
  });
});

describe("renderProsePageMarkdown", () => {
  it("renders each trust page with enough real content", () => {
    for (const page of prosePages) {
      const markdown = renderProsePageMarkdown(page);
      expect(markdown.startsWith(`# ${page.heading}\n`)).toBe(true);
      expect(markdown.length).toBeGreaterThan(500);
    }
  });

  it("tells the founder what Disconnect sends to this site", () => {
    const markdown = renderProsePageMarkdown(privacyPage);
    expect(markdown).toMatch(/\[Stripe Connect\]\([^)]*\): .*when you disconnect/iu);
  });
});

describe("renderNotFoundMarkdown", () => {
  it("names the missing path and points at recovery surfaces", () => {
    const body = renderNotFoundMarkdown("/nope");
    expect(body).toContain("`/nope`");
    expect(body).toContain("https://idlebiz.com/sitemap.xml");
    expect(body).toContain("https://idlebiz.com/llms.txt");
  });
});
