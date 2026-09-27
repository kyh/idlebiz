import { ProsePageView, prosePageMetadata } from "@/app/prose-page";
import { privacyPage } from "@/lib/agent/site-content";

export const metadata = prosePageMetadata(privacyPage);

const Privacy = () => <ProsePageView page={privacyPage} />;

export default Privacy;
