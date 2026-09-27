import Link from "next/link";

import { JsonLd } from "@/app/json-ld";
import { SiteFooter } from "@/app/site-footer";
import type { LinkItem, ProseBlock, ProsePage } from "@/lib/agent/site-content";
import { pageGraph } from "@/lib/agent/structured-data";
import { pageMetadata } from "@/lib/page-metadata";

export const prosePageMetadata = (page: ProsePage) =>
  pageMetadata(page.path, page.title, page.description);

const ItemLabel = ({ item }: { item: LinkItem }) => {
  if (!item.href) {
    return <strong>{item.label}</strong>;
  }
  if (item.href.startsWith("/") && !item.href.includes(".")) {
    return (
      <Link href={item.href} className="underline">
        {item.label}
      </Link>
    );
  }
  return (
    <a href={item.href} className="underline">
      {item.label}
    </a>
  );
};

const Block = ({ block }: { block: ProseBlock }) => {
  if (block.kind === "heading") {
    return <h2 className="pt-2 text-[16px] text-fg">{block.text}</h2>;
  }
  if (block.kind === "list") {
    return (
      <ul className="list-disc space-y-1.5 pl-5">
        {block.items.map((item) => (
          <li key={item.label}>
            <ItemLabel item={item} />
            {item.text ? ` — ${item.text}` : null}
          </li>
        ))}
      </ul>
    );
  }
  return <p>{block.text}</p>;
};

export const ProsePageView = ({ page }: { page: ProsePage }) => (
  <main className="px-floor flex min-h-dvh flex-col items-center px-4 py-10">
    <JsonLd node={pageGraph(page)} />
    <article className="px-window w-full max-w-2xl">
      <div className="px-titlebar flex items-center justify-between px-3 py-1.5 text-[12px] uppercase tracking-wider">
        <Link href="/" className="no-underline">
          IdleBiz.exe
        </Link>
        <span>{page.title}</span>
      </div>
      <div className="space-y-4 px-6 pt-6 pb-8 text-[13px] leading-relaxed text-fg sm:px-10 sm:text-[14px]">
        <h1 className="text-[28px] leading-tight text-fg">{page.heading}</h1>
        {page.blocks.map((block) => (
          <Block
            key={
              block.kind === "list" ? block.items.map((item) => item.label).join(",") : block.text
            }
            block={block}
          />
        ))}
      </div>
    </article>
    <SiteFooter />
  </main>
);
