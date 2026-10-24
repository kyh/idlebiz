import type { Metadata } from "next";

import { siteConfig } from "@/lib/site-config";

/** Where a page's own share card is served: its segment's `opengraph-image`. */
export const ogImagePath = (path: string): string => `${path === "/" ? "" : path}/opengraph-image`;

/**
 * The office clip, on the home page only. Crawlers want og:video absolute, which
 * `metadataBase` does not do for videos.
 */
const homeVideos = () => {
  const { height, url, width } = siteConfig.video;
  const absolute = `${siteConfig.url}${url}`;
  return [{ height, secureUrl: absolute, type: "video/mp4", url: absolute, width }];
};

/**
 * A page's `openGraph` and `twitter` each replace the layout's whole object
 * rather than merging into it — og:image included, since a segment's
 * `opengraph-image.tsx` only reaches pages that leave `openGraph` alone. So
 * this restates every field, and states `twitter` too: X reads twitter:* over
 * og:*, so the layout's would give every page the home card.
 */
export const pageMetadata = (
  path: string,
  title: string | null,
  description: string = siteConfig.description,
): Metadata => {
  const cardTitle = title ? `${title} | ${siteConfig.name}` : siteConfig.name;
  const image = {
    alt: `${cardTitle} — ${description}`,
    height: 630,
    url: ogImagePath(path),
    width: 1200,
  };
  const openGraph: NonNullable<Metadata["openGraph"]> = {
    description,
    images: [image],
    locale: "en-US",
    siteName: siteConfig.name,
    title: cardTitle,
    type: "website",
    url: path,
  };
  if (path === "/") {
    openGraph.videos = homeVideos();
  }
  const metadata: Metadata = {
    alternates: { canonical: path },
    description,
    openGraph,
    twitter: {
      card: "summary_large_image",
      creator: siteConfig.twitter,
      description,
      images: [image],
      title: cardTitle,
    },
  };
  if (title) {
    metadata.title = title;
  }
  return metadata;
};
