import { ogCard } from "@/app/og-card";
import { siteConfig } from "@/lib/site-config";

export { OG_SIZE as size, siteCardAlt as alt } from "@/app/og-card";
export const contentType = "image/png";

const OpengraphImage = () =>
  ogCard({
    bar: "",
    heading: siteConfig.name,
    line: "An idle business sim where your employees are real AI agents.",
  });

export default OpengraphImage;
