import { pageCard, pageCardAlt } from "@/app/og-card";
import { contactPage } from "@/lib/agent/site-content";

export const alt = pageCardAlt(contactPage);
export { OG_SIZE as size } from "@/app/og-card";
export const contentType = "image/png";

const OpengraphImage = () => pageCard(contactPage);

export default OpengraphImage;
