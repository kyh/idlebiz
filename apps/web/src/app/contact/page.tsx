import { ProsePageView, prosePageMetadata } from "@/app/prose-page";
import { contactPage } from "@/lib/agent/site-content";

export const metadata = prosePageMetadata(contactPage);

const Contact = () => <ProsePageView page={contactPage} />;

export default Contact;
