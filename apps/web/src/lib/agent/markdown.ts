import { siteConfig } from "@/lib/site-config";

import {
  gettingStarted,
  homeIntro,
  isPlainRun,
  siteLinks,
  siteSummary,
  whenToUse,
} from "@/lib/agent/site-content";
import type { LinkItem, ProseBlock, ProsePage, Run } from "@/lib/agent/site-content";

/** A page of this site gets its full URL; an in-page anchor, mail and other sites stay as written. */
const absoluteUrl = (href: string): string =>
  href.startsWith("/") ? `${siteConfig.url}${href}` : href;

const renderList = (items: LinkItem[]): string =>
  items
    .map((item) => {
      const label = item.href ? `[${item.label}](${absoluteUrl(item.href)})` : `**${item.label}**`;
      return item.text ? `- ${label}: ${item.text}` : `- ${label}`;
    })
    .join("\n");

const renderRun = (run: Run): string => {
  if (isPlainRun(run)) {
    return run;
  }
  if (run.kind === "strong") {
    return `**${run.text}**`;
  }
  return `[${run.text}](${absoluteUrl(run.href)})`;
};

const renderRuns = (runs: Run[]): string => runs.map((run) => renderRun(run)).join("");

/** One GFM table row; a pipe inside a cell is escaped so it cannot split the cell. */
const tableRow = (cells: string[]): string =>
  `| ${cells.map((cell) => cell.replaceAll("|", String.raw`\|`)).join(" | ")} |`;

const renderBlock = (block: ProseBlock): string => {
  switch (block.kind) {
    case "heading": {
      return `## ${block.text}`;
    }
    case "subheading": {
      return `### ${block.text}`;
    }
    case "list": {
      return renderList(block.items);
    }
    case "bullets": {
      return block.items.map((item) => `- ${renderRuns(item)}`).join("\n");
    }
    case "table": {
      return [
        tableRow(block.columns),
        tableRow(block.columns.map(() => "---")),
        ...block.rows.map((row) => tableRow(row)),
      ].join("\n");
    }
    case "rule": {
      return "---";
    }
    case "paragraph": {
      return renderRuns(block.runs);
    }
    // no default
  }
};

const document = (lines: string[]): string => `${lines.join("\n").trimEnd()}\n`;

const footer = `[${siteConfig.name}](${siteConfig.url}) · [Sitemap](${absoluteUrl("/sitemap.xml")}) · [llms.txt](${absoluteUrl("/llms.txt")})`;

export const renderHomeMarkdown = (): string =>
  document([
    `# ${siteConfig.name}`,
    "",
    `> ${siteSummary}`,
    "",
    ...homeIntro.flatMap((paragraph) => [paragraph, ""]),
    `## When to use ${siteConfig.name}`,
    "",
    renderList(whenToUse),
    "",
    "## Get started",
    "",
    renderList(gettingStarted),
    "",
    "## Pages",
    "",
    renderList(siteLinks),
  ]);

export const renderProsePageMarkdown = (page: ProsePage): string =>
  document([
    `# ${page.heading}`,
    "",
    `> ${page.description}`,
    "",
    ...page.blocks.flatMap((block) => [renderBlock(block), ""]),
    "---",
    "",
    footer,
  ]);

export const renderNotFoundMarkdown = (pathname: string): string =>
  document([
    "# Page not found",
    "",
    `Nothing lives at \`${pathname}\` on ${siteConfig.name}. It may have moved, or the URL is mistyped. Try one of these instead:`,
    "",
    renderList(siteLinks),
  ]);

/**
 * llmstxt.org shape: H1, blockquote, free prose, then H2 link lists. The
 * when-to-use guidance stays in the prose block because the spec reserves H2
 * sections for links.
 */
export const renderLlmsTxt = (): string =>
  document([
    `# ${siteConfig.name}`,
    "",
    `> ${siteSummary}`,
    "",
    ...homeIntro.flatMap((paragraph) => [paragraph, ""]),
    `**When to use ${siteConfig.name}:**`,
    "",
    renderList(whenToUse),
    "",
    "Every page on this site is also served as Markdown: request it with `Accept: text/markdown`.",
    "",
    "## Get started",
    "",
    renderList(gettingStarted),
    "",
    "## Pages",
    "",
    renderList(siteLinks.filter((link) => link.href !== "/llms.txt")),
    "",
    "## Optional",
    "",
    renderList([
      {
        href: `${siteConfig.repository}/issues`,
        label: "Issue tracker",
        text: "bugs and feature requests",
      },
      { href: `${siteConfig.repository}/releases`, label: "Releases", text: "every version" },
    ]),
  ]);
