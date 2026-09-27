import type { Metadata } from "next";

import { siteConfig } from "@/lib/site-config";

/**
 * A page's `openGraph` and `twitter` each replace the layout's whole object
 * rather than merging into it — og:image included, since
 * `app/opengraph-image.tsx` only reaches pages that leave `openGraph` alone. So
 * this restates every field, and states `twitter` too: X reads twitter:* over
 * og:*, so the layout's would give every page the home card.
 */
export const pageMetadata = (
  path: string,
  title: string | null,
  description: string = siteConfig.description,
): Metadata => {
  const cardTitle = title ? `${title} | ${siteConfig.name}` : siteConfig.name;
  const metadata: Metadata = {
    alternates: { canonical: path },
    description,
    openGraph: {
      description,
      images: [{ alt: siteConfig.name, height: 630, url: "/opengraph-image", width: 1200 }],
      locale: "en-US",
      siteName: siteConfig.name,
      title: cardTitle,
      type: "website",
      url: path,
    },
    twitter: { card: "summary", creator: siteConfig.twitter, description, title: cardTitle },
  };
  if (title) {
    metadata.title = title;
  }
  return metadata;
};
