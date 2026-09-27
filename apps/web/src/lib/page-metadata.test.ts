import { describe, expect, it } from "vitest";

import { pageMetadata } from "./page-metadata";

describe("pageMetadata", () => {
  it("gives X the page's own card, since twitter:* outranks og:* there", () => {
    const metadata = pageMetadata("/privacy", "Privacy", "What the site collects.");
    expect(metadata.twitter).toEqual({
      card: "summary",
      creator: "@kaiyuhsu",
      description: "What the site collects.",
      title: "Privacy | IdleBiz",
    });
  });
});
