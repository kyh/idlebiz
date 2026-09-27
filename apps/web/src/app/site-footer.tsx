import Link from "next/link";

import { prosePages } from "@/lib/agent/site-content";
import { siteConfig } from "@/lib/site-config";

export const SiteFooter = () => (
  <footer className="mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11px] text-chrome-hi">
    <a href={siteConfig.repository} className="no-underline hover:text-light">
      GitHub
    </a>
    {prosePages.map((page) => (
      <Link key={page.path} href={page.path} className="no-underline hover:text-light">
        {page.title}
      </Link>
    ))}
    <span aria-hidden>·</span>
    <span>© 2026 kyh</span>
    <span aria-hidden>·</span>
    <span>{siteConfig.name} is in early development</span>
  </footer>
);
