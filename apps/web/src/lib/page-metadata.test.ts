import { describe, expect, it } from "vitest";

import { ogImagePath, pageMetadata } from "./page-metadata";

describe("pageMetadata", () => {
  it("gives X the page's own card, since twitter:* outranks og:* there", () => {
    const metadata = pageMetadata("/privacy", "Privacy", "What the site collects.");
    expect(metadata.twitter).toEqual({
      card: "summary_large_image",
      creator: "@kaiyuhsu",
      description: "What the site collects.",
      images: [
        {
          alt: "Privacy | IdleBiz — What the site collects.",
          height: 630,
          url: "/privacy/opengraph-image",
          width: 1200,
        },
      ],
      title: "Privacy | IdleBiz",
    });
  });

  it("points each page at its own share card", () => {
    expect(ogImagePath("/")).toBe("/opengraph-image");
    expect(ogImagePath("/terms")).toBe("/terms/opengraph-image");
  });

  it("carries the office clip, absolute, on the home page alone", () => {
    expect(pageMetadata("/", null).openGraph).toHaveProperty("videos", [
      {
        height: 630,
        secureUrl: "https://idlebiz.com/og/og.mp4",
        type: "video/mp4",
        url: "https://idlebiz.com/og/og.mp4",
        width: 1200,
      },
    ]);
    expect(pageMetadata("/about", "About").openGraph).not.toHaveProperty("videos");
  });
});
