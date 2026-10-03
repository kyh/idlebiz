import { ProsePageView, prosePageMetadata } from "@/app/prose-page";
import { termsPage } from "@/lib/agent/site-content";

export const metadata = prosePageMetadata(termsPage);

const Terms = () => <ProsePageView page={termsPage} />;

export default Terms;
