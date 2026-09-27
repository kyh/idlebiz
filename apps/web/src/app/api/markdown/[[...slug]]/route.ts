import { MARKDOWN_CONTENT_TYPE } from "@/lib/agent/accept";
import {
  renderHomeMarkdown,
  renderNotFoundMarkdown,
  renderProsePageMarkdown,
} from "@/lib/agent/markdown";
import { findProsePage } from "@/lib/agent/site-content";

/**
 * The Markdown half of content negotiation: `src/proxy.ts` rewrites here when a
 * client prefers `text/markdown`. Not a public URL. An unknown path answers 404
 * with a Markdown body pointing at the sitemap and llms.txt.
 */
interface MarkdownReply {
  body: string;
  status: 200 | 404;
}

const buildBody = (segments: string[]): MarkdownReply => {
  if (segments.length === 0) {
    return { body: renderHomeMarkdown(), status: 200 };
  }
  const pathname = `/${segments.join("/")}`;
  const page = findProsePage(pathname);
  if (page) {
    return { body: renderProsePageMarkdown(page), status: 200 };
  }
  return { body: renderNotFoundMarkdown(pathname), status: 404 };
};

export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
): Promise<Response> => {
  const { slug = [] } = await params;
  const { body, status } = buildBody(slug);
  return new Response(body, {
    headers: {
      "Cache-Control":
        status === 200
          ? "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400"
          : "no-store",
      "Content-Type": MARKDOWN_CONTENT_TYPE,
      Vary: "Accept",
    },
    status,
  });
};
