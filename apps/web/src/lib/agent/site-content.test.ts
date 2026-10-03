import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { siteConfig } from "@/lib/site-config";

import { renderProsePageMarkdown } from "./markdown";
import {
  findProsePage,
  generalLegalCredit,
  headingAnchors,
  headingSlug,
  isPlainRun,
  legalRevisedOn,
  legalSourcePath,
  privacyPage,
  prosePages,
  termsPage,
} from "./site-content";
import type { ProseBlock, ProsePage, Run } from "./site-content";

type LinkRun = Extract<Run, { kind: "link" }>;

const isLink = (run: Run): run is LinkRun => !isPlainRun(run) && run.kind === "link";

const runsOf = (block: ProseBlock): Run[] => {
  if (block.kind === "paragraph") {
    return block.runs;
  }
  if (block.kind === "bullets") {
    return block.items.flat();
  }
  return [];
};

const linksOf = (page: ProsePage): string[] =>
  page.blocks
    .flatMap(runsOf)
    .filter(isLink)
    .map((run) => run.href);

const headingsOf = (page: ProsePage): string[] =>
  page.blocks.flatMap((block) => (block.kind === "heading" ? [block.text] : []));

const legalPages = [privacyPage, termsPage];

describe("heading anchors", () => {
  it("slug a heading the way GitHub does, so the Markdown twin's links resolve too", () => {
    expect(headingSlug("Tracking & Other Technologies")).toBe("tracking--other-technologies");
    expect(headingSlug("11. Dispute Resolution")).toBe("11-dispute-resolution");
    expect(headingSlug("Data Processing outside Europe")).toBe("data-processing-outside-europe");
  });

  it("number a repeated heading rather than give two headings one id", () => {
    const anchors = [...headingAnchors(privacyPage.blocks).values()];
    expect(anchors).toContain("retention");
    expect(anchors).toContain("retention-1");
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("back every in-page link on every page", () => {
    for (const page of prosePages) {
      for (const href of linksOf(page)) {
        const [pathname, fragment] = href.split("#");
        if (fragment === undefined) {
          continue;
        }
        const target = pathname ? findProsePage(pathname) : page;
        expect(target, href).toBeDefined();
        expect([...headingAnchors(target?.blocks ?? []).values()], href).toContain(fragment);
      }
    }
  });
});

describe("the Privacy Policy", () => {
  const markdown = renderProsePageMarkdown(privacyPage);

  it("keeps the template's sections, in its order", () => {
    expect(headingsOf(privacyPage)).toEqual([
      "Personal information we collect",
      "Tracking & Other Technologies",
      "How we use your personal information",
      "Retention",
      "How we share your personal information",
      "Your choices",
      "Other sites and services",
      "Security",
      "International data transfer",
      "Children",
      "Changes to this Privacy Policy",
      "How to contact us",
      "State privacy rights notice",
      "Notice to European users",
    ]);
  });

  it("opens with its effective date and an index of every section", () => {
    expect(markdown).toContain(`Effective as of ${legalRevisedOn}.`);
    const index = headingsOf(privacyPage)
      .map((heading) => `- [${heading}](#${headingSlug(heading)})`)
      .join("\n");
    expect(markdown).toContain(`**Index**\n\n${index}\n`);
  });

  it("points its previous versions at the history of the file that holds its text", () => {
    expect(linksOf(privacyPage)).toContain(
      `${siteConfig.repository}/commits/main/${legalSourcePath}`,
    );
    const root = path.resolve(import.meta.dirname, "../../../../..");
    expect(path.join(root, legalSourcePath)).toBe(
      path.join(import.meta.dirname, "site-content.ts"),
    );
    expect(existsSync(path.join(root, legalSourcePath))).toBe(true);
  });

  it("names the founder, not us, as the one answerable for buyers' data", () => {
    expect(markdown).toMatch(
      /we never receive it: you, as the founder running the company, decide how your buyers' personal information is used/u,
    );
  });

  it("keeps the promises the old page made", () => {
    for (const promise of [
      "Our website does not use cookies or other tracking technologies",
      "We use no analytics on the website or in the desktop app.",
      "We do not sell your personal information or share it with advertisers.",
      "It has no telemetry and no crash reporting to us.",
      "never handed to your employees",
      "keeps no copy",
    ]) {
      expect(markdown).toContain(promise);
    }
  });

  it("says Kaiyu Hsu is the controller, with no representative or officer it does not have", () => {
    expect(markdown).toContain("Kaiyu Hsu, who provides IdleBiz, is the controller");
    expect(markdown).not.toMatch(/Representative in the|Data Protection Officer/u);
  });
});

describe("the Terms of Use", () => {
  const markdown = renderProsePageMarkdown(termsPage);

  it("numbers its eleven sections as the template does, so cross-references hold", () => {
    expect(headingsOf(termsPage)).toEqual([
      "1. Accounts",
      "2. Access to the Site",
      "3. Privacy",
      "4. Indemnification",
      "5. Third-Party Services & Other Users",
      "6. Disclaimers",
      "7. Limitation of Liability",
      "8. Term and Termination",
      "9. State-Specific Legal Notices",
      "10. General",
      "11. Dispute Resolution",
    ]);
  });

  it("is version 1.0, revised on the same day the Privacy Policy took effect", () => {
    expect(markdown).toContain(`**Version 1.0 Last revised:** ${legalRevisedOn}`);
  });

  it("defines the Site as the website and the desktop app, run by Kaiyu Hsu", () => {
    expect(markdown).toMatch(
      /The website located at idlebiz\.com, together with the IdleBiz desktop app for macOS \(collectively, the "\*\*Site\*\*"\) is owned and operated by Kaiyu Hsu/u,
    );
  });

  it("claims no open-source license, since the repository has none", () => {
    expect(markdown).toContain("It is not released under an open-source license");
    expect(markdown).not.toMatch(/MIT License|licensed under the/u);
  });

  it("links the Privacy Policy, which links back", () => {
    expect(linksOf(termsPage)).toContain("/privacy");
    expect(linksOf(privacyPage)).toContain("/terms");
  });

  it("resolves disputes before JAMS in San Francisco County, under California law", () => {
    expect(markdown).toContain("administered by JAMS");
    expect(markdown).toContain("the laws of the State of California");
    expect(markdown).toContain(
      "the state and federal courts located in San Francisco County, California",
    );
    expect(markdown).not.toMatch(/DecisionLayer/u);
  });
});

describe("both legal documents", () => {
  it("end with General Legal's credit, after a divider", () => {
    for (const page of legalPages) {
      expect(page.blocks.at(-2)).toEqual({ kind: "rule" });
      expect(page.blocks.at(-1)).toEqual({ kind: "paragraph", runs: [generalLegalCredit] });
    }
  });

  it("leave no placeholder, bracket or drafting note from the template", () => {
    for (const page of legalPages) {
      const markdown = renderProsePageMarkdown(page);
      expect(markdown).not.toMatch(/<mark>|INSERT|\{\{|\bTBD\b/u);
      expect(markdown).not.toMatch(/\[[^\]]*\](?!\()/u);
    }
  });

  it("give one email address for every request", () => {
    for (const page of legalPages) {
      const mail = linksOf(page).filter((href) => href.startsWith("mailto:"));
      expect(mail.length).toBeGreaterThan(0);
      expect(new Set(mail)).toEqual(new Set([`mailto:${siteConfig.email}`]));
    }
  });

  it("set the minimum age at 18", () => {
    expect(renderProsePageMarkdown(termsPage)).toContain(
      "You must be at least 18 years old to use the Site.",
    );
    expect(renderProsePageMarkdown(privacyPage)).toContain(
      "The Service is not intended for use by anyone under 18 years of age.",
    );
  });

  it("give every table row one cell per column", () => {
    for (const page of prosePages) {
      for (const block of page.blocks) {
        if (block.kind === "table") {
          for (const row of block.rows) {
            expect(row).toHaveLength(block.columns.length);
          }
        }
      }
    }
  });
});
