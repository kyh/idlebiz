import Link from "next/link";
import type { ReactNode } from "react";

import { JsonLd } from "@/app/json-ld";
import { SiteFooter } from "@/app/site-footer";
import { headingAnchors, isPlainRun } from "@/lib/agent/site-content";
import type { LinkItem, ProseBlock, ProsePage, Run } from "@/lib/agent/site-content";
import { pageGraph } from "@/lib/agent/structured-data";
import { pageMetadata } from "@/lib/page-metadata";

export const prosePageMetadata = (page: ProsePage) =>
  pageMetadata(page.path, page.title, page.description);

/** A page of this site goes through next/link; a file, an anchor, mail and other sites stay plain links. */
const TextLink = ({ children, href }: { children: ReactNode; href: string }) => {
  if (href.startsWith("/") && !href.includes(".")) {
    return (
      <Link href={href} className="underline">
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className="underline">
      {children}
    </a>
  );
};

const ItemLabel = ({ item }: { item: LinkItem }) => {
  if (!item.href) {
    return <strong>{item.label}</strong>;
  }
  return <TextLink href={item.href}>{item.label}</TextLink>;
};

const RunView = ({ run }: { run: Run }) => {
  if (isPlainRun(run)) {
    return run;
  }
  if (run.kind === "strong") {
    return <strong>{run.text}</strong>;
  }
  return <TextLink href={run.href}>{run.text}</TextLink>;
};

const Runs = ({ runs }: { runs: Run[] }) =>
  runs.map((run, index) => <RunView key={index} run={run} />);

const CELL_CLASS = "border-2 border-ink px-2 py-1.5 align-top";

const Block = ({ anchor, block }: { anchor: string | undefined; block: ProseBlock }) => {
  switch (block.kind) {
    case "heading": {
      return (
        <h2 id={anchor} className="pt-2 text-[16px] text-fg">
          {block.text}
        </h2>
      );
    }
    case "subheading": {
      return (
        <h3 id={anchor} className="pt-1 text-[14px] text-fg">
          {block.text}
        </h3>
      );
    }
    case "list": {
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
    case "bullets": {
      return (
        <ul className="list-disc space-y-1.5 pl-5">
          {block.items.map((item, index) => (
            <li key={index}>
              <Runs runs={item} />
            </li>
          ))}
        </ul>
      );
    }
    case "table": {
      return (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-left text-[12px] leading-snug">
            <thead>
              <tr>
                {block.columns.map((column) => (
                  <th key={column} scope="col" className={`${CELL_CLASS} bg-face-lo`}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column} className={CELL_CLASS}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "rule": {
      return <hr className="border-t-2 border-face-lo" />;
    }
    case "paragraph": {
      return (
        <p>
          <Runs runs={block.runs} />
        </p>
      );
    }
    // no default
  }
};

export const ProsePageView = ({ page }: { page: ProsePage }) => {
  const anchors = headingAnchors(page.blocks);
  return (
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
          {page.blocks.map((block, index) => (
            <Block key={index} anchor={anchors.get(block)} block={block} />
          ))}
        </div>
      </article>
      <SiteFooter />
    </main>
  );
};
