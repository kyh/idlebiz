import { pageCard, pageCardAlt } from "@/app/og-card";
import { aboutPage } from "@/lib/agent/site-content";

export const alt = pageCardAlt(aboutPage);
export { OG_SIZE as size } from "@/app/og-card";
export const contentType = "image/png";

const OpengraphImage = () => pageCard(aboutPage);

export default OpengraphImage;
