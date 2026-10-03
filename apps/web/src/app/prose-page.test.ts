import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProsePageView } from "@/app/prose-page";
import {
  generalLegalCredit,
  privacyPage,
  prosePages,
  servedPages,
  termsPage,
} from "@/lib/agent/site-content";
import type { ProsePage } from "@/lib/agent/site-content";

const html = (page: ProsePage): string =>
  renderToStaticMarkup(createElement(ProsePageView, { page }));

describe("ProsePageView", () => {
  const privacy = html(privacyPage);

  it("gives each heading the anchor the index and the Markdown twin link to", () => {
    expect(privacy).toContain('<a href="#tracking--other-technologies" class="underline">');
    expect(privacy).toContain('<h2 id="tracking--other-technologies"');
    expect(privacy).toContain('<h2 id="retention"');
    expect(privacy).toContain('<h3 id="retention-1"');
  });

  it("renders a table with a header cell for each column", () => {
    const columns = privacyPage.blocks.flatMap((block) =>
      block.kind === "table" ? [block.columns.length] : [],
    );
    expect(columns.length).toBeGreaterThan(0);
    expect(privacy.match(/<table/gu)).toHaveLength(columns.length);
    expect(privacy.match(/<th scope="col"/gu)).toHaveLength(
      columns.reduce((sum, count) => sum + count, 0),
    );
    expect(privacy).toContain("<td");
  });

  it("renders bold terms and links inside a paragraph", () => {
    expect(privacy).toContain("<li><strong>Contact data</strong>, such as your name");
    expect(privacy).toContain('<a href="mailto:kai@kyh.io" class="underline">kai@kyh.io</a>');
  });

  it("shows no link to the Terms of Use on any page, in its text or its footer", () => {
    for (const page of servedPages) {
      const markup = html(page);
      for (const listed of prosePages) {
        expect(markup, page.path).toContain(`href="${listed.path}"`);
      }
      expect(markup, page.path).not.toContain(`href="${termsPage.path}`);
    }
  });

  it("ends each legal document with General Legal's credit, after a divider", () => {
    for (const page of [privacyPage, termsPage]) {
      const markup = html(page);
      const divider = markup.lastIndexOf("<hr");
      expect(divider).toBeGreaterThan(0);
      expect(markup.indexOf(generalLegalCredit.slice(0, 40))).toBeGreaterThan(divider);
    }
  });
});
