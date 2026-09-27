import type { Metadata } from "next";

import { siteConfig } from "@/lib/site-config";

/**
 * A page's `openGraph` replaces the layout's whole object rather than merging
 * into it — og:image included, since `app/opengraph-image.tsx` only reaches
 * pages that leave `openGraph` alone. So this restates every field.
 */
export const pageMetadata = (
  path: string,
  title: string | null,
  description: string = siteConfig.description,
): Metadata => {
  const metadata: Metadata = {
    alternates: { canonical: path },
    description,
    openGraph: {
      description,
      images: [{ alt: siteConfig.name, height: 630, url: "/opengraph-image", width: 1200 }],
      locale: "en-US",
      siteName: siteConfig.name,
      title: title ? `${title} | ${siteConfig.name}` : siteConfig.name,
      type: "website",
      url: path,
    },
  };
  if (title) {
    metadata.title = title;
  }
  return metadata;
};
