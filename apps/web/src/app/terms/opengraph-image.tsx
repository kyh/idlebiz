import { pageCard, pageCardAlt } from "@/app/og-card";
import { termsPage } from "@/lib/agent/site-content";

export const alt = pageCardAlt(termsPage);
export { OG_SIZE as size } from "@/app/og-card";
export const contentType = "image/png";

const OpengraphImage = () => pageCard(termsPage);

export default OpengraphImage;
