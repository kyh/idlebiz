import { ProsePageView, prosePageMetadata } from "@/app/prose-page";
import { aboutPage } from "@/lib/agent/site-content";

export const metadata = prosePageMetadata(aboutPage);

const About = () => <ProsePageView page={aboutPage} />;

export default About;
