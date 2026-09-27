import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { negotiateMediaType, notAcceptableBody, withVaryAccept } from "@/lib/agent/accept";

/**
 * Markdown content negotiation: one URL, two representations. Server
 * Components always render HTML, so Markdown-preferring requests are rewritten
 * to `/api/markdown/*` before the page renders.
 * <https://acceptmarkdown.com/recipes/nextjs>
 */

const applyVary = (response: NextResponse): NextResponse => {
  response.headers.set("Vary", withVaryAccept(response.headers.get("Vary")));
  return response;
};

// React's own transport (`Accept: text/x-component`, Server Actions): never negotiate it.
const isFlightRequest = (request: NextRequest): boolean =>
  (request.headers.get("accept") ?? "").toLowerCase().includes("text/x-component") ||
  request.headers.has("next-action");

export const proxy = (request: NextRequest) => {
  if (isFlightRequest(request)) {
    return applyVary(NextResponse.next());
  }

  const accept = request.headers.get("accept");
  const chosen = negotiateMediaType(accept);

  if (chosen === "text/markdown") {
    const url = request.nextUrl.clone();
    const { pathname } = request.nextUrl;
    url.pathname = `/api/markdown${pathname === "/" ? "" : pathname}`;
    return applyVary(NextResponse.rewrite(url));
  }

  if (chosen === null) {
    return new Response(notAcceptableBody(accept), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        Vary: "Accept",
      },
      status: 406,
    });
  }

  return applyVary(NextResponse.next());
};

/**
 * Only an Accept that names markdown invokes the proxy, so HTML views never pay
 * for an invocation. Next and Vercel both compile `has` to an anchored,
 * case-sensitive regex, hence the per-character case spelling.
 */
export const config = {
  matcher: [
    {
      has: [{ key: "accept", type: "header", value: ".*[Mm][Aa][Rr][Kk][Dd][Oo][Ww][Nn].*" }],
      source:
        "/((?!api/|_next/|_vercel/|office/|robots\\.txt$|sitemap\\.xml$|llms\\.txt$|icon\\.png$|opengraph-image).*)",
    },
  ],
};
