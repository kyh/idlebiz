import type { MetadataRoute } from "next";

import { servedPages } from "@/lib/agent/site-content";
import { siteConfig } from "@/lib/site-config";

const sitemap = (): MetadataRoute.Sitemap => [
  { changeFrequency: "weekly", priority: 1, url: siteConfig.url },
  ...servedPages.map((page): MetadataRoute.Sitemap[number] => ({
    changeFrequency: "monthly",
    priority: 0.5,
    url: `${siteConfig.url}${page.path}`,
  })),
];

export default sitemap;
