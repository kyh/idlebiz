import type { MetadataRoute } from "next";

import { pageRevisedOn, servedPages, siteUpdatedIso } from "@/lib/agent/site-content";
import { siteConfig } from "@/lib/site-config";

const sitemap = () =>
  [
    { changeFrequency: "weekly", lastModified: siteUpdatedIso, priority: 1, url: siteConfig.url },
    ...servedPages.map(
      (page) =>
        ({
          changeFrequency: "monthly",
          lastModified: pageRevisedOn(page),
          priority: 0.5,
          url: `${siteConfig.url}${page.path}`,
        }) satisfies MetadataRoute.Sitemap[number],
    ),
  ] satisfies MetadataRoute.Sitemap;

export default sitemap;
