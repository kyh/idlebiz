import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/site-config";

const manifest = (): MetadataRoute.Manifest => ({
  background_color: "#12141c",
  categories: ["games", "business", "productivity"],
  description: siteConfig.description,
  display: "standalone",
  icons: [{ purpose: "any", sizes: "180x180", src: "/icon.png", type: "image/png" }],
  id: "/",
  lang: "en-US",
  name: siteConfig.name,
  short_name: siteConfig.name,
  start_url: "/",
  theme_color: "#12141c",
});

export default manifest;
