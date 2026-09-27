import type { MetadataRoute } from "next";

import { prosePages } from "@/lib/agent/site-content";
import { siteConfig } from "@/lib/site-config";

const sitemap = (): MetadataRoute.Sitemap => [
  { changeFrequency: "weekly", priority: 1, url: siteConfig.url },
  ...prosePages.map((page): MetadataRoute.Sitemap[number] => ({
    changeFrequency: "monthly",
    priority: 0.5,
    url: `${siteConfig.url}${page.path}`,
  })),
];

export default sitemap;
