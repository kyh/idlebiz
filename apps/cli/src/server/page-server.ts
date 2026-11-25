import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { HANDOFF_PARAM, RPC_PREFIX } from "@repo/contract/routes";
import { listenLoopback } from "./lib/http";
import { createPageSession, fromOwnOrigin, loopbackOrigin } from "./page-session";
import { errorMessage } from "@repo/domain/errors";
import type { JsonValue } from "@repo/domain/json";
import { pagePolicy } from "@repo/contract/page-policy";

/** Where the page's files come from: the built page main ships beside it, or Vite's dev server. */
export type PageSource = { kind: "built"; dir: string } | { kind: "dev"; origin: string };

export interface PageServerOptions {
  page: PageSource;
  /**
   * Answers a call under RPC_PREFIX: the page router's RPC handler, which writes the answer. False
   * when no procedure matched the path.
   */
  handleRpc: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  /** The clock a handoff's five minutes are kept on. */
  now?: () => number;
}

/** What the shell opens its window on: the link, and the origin the window is pinned to. */
interface Handoff {
  origin: string;
  handoffUrl: string;
}

export interface PageServer {
  /** `http://127.0.0.1:<port>`, the one origin the window shows. */
  origin: string;
  port: number;
  /** A link that signs a page in, once, within five minutes, and lands it on the office. */
  handoff: () => Handoff;
  /** Ends every call, event streams included, and stops answering. */
  stop: () => Promise<void>;
}

const FILE_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

const BASE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const DOCUMENT_HEADERS = {
  ...BASE_HEADERS,
  "content-security-policy": pagePolicy(),
  "content-type": "text/html; charset=utf-8",
};

const SIGNED_OUT_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>IdleBiz</title></head>
<body>
<h1>IdleBiz</h1>
<p>This page opens in IdleBiz's own window, which signs it in. Open IdleBiz to see your office.</p>
<p>Working on IdleBiz? <code>pnpm dev:browser</code> prints a link that signs a browser in.</p>
</body>
</html>
`;

const DROPPED_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

const live = new Set<number>();

export const pagePorts = () => [...live];

/**
 * The origin of a dev server main may take the page's files from: a loopback http one, as
 * `pnpm dev:desktop` and `pnpm dev:browser` name Vite. Anything else is refused, since the page
 * it answers holds the founder's approve button.
 */
export const devPageOrigin = (url: string) => {
  const parsed = URL.canParse(url) ? new URL(url) : null;

  if (
    parsed === null ||
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(`the page's dev server must be a loopback http origin, not ${url}`);
  }

  return parsed.origin;
};

const onlyHeader = (request: IncomingMessage, name: string) => {
  const values = request.headersDistinct[name];

  return values?.length === 1 ? values[0] : undefined;
};

const sendJson = (response: ServerResponse, status: number, body: JsonValue) => {
  response.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const refuse = (response: ServerResponse, status: number, message: string) => {
  sendJson(response, status, { message, ok: false });
};

const notFound = (response: ServerResponse) => {
  response.writeHead(404, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
};

const signedOut = (request: IncomingMessage, response: ServerResponse) => {
  response.writeHead(401, DOCUMENT_HEADERS);
  response.end(request.method === "HEAD" ? undefined : SIGNED_OUT_PAGE);
};

const fileUnder = (dir: string, pathname: string) => {
  let name: string;

  try {
    name = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const file = path.join(dir, name);

  return name.includes("\0") || !file.startsWith(`${dir}${path.sep}`) ? null : file;
};

const serveFile = async (
  dir: string,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
) => {
  const file = fileUnder(dir, pathname);
  const type = file === null ? undefined : FILE_TYPES.get(path.extname(file));

  if (file === null || type === undefined) {
    notFound(response);

    return;
  }

  let bytes: Buffer;

  try {
    bytes = await readFile(file);
  } catch {
    notFound(response);

    return;
  }

  response.writeHead(200, { ...BASE_HEADERS, "content-type": type });
  response.end(request.method === "HEAD" ? undefined : bytes);
};

// WARNING: set the path on Vite's origin, never resolve it there: `//host/x` reaches another host.
const forward = async (
  origin: string,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) => {
  const target = new URL(origin);
  target.pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  target.search = url.search;

  const upstream = await fetch(target, {
    headers: { accept: onlyHeader(request, "accept") ?? "*/*" },
    method: request.method ?? "GET",
  });

  const headers: Record<string, string> = {};

  for (const [name, value] of upstream.headers) {
    if (!DROPPED_HEADERS.has(name)) {
      headers[name] = value;
    }
  }

  response.writeHead(upstream.status, headers);
  response.end(request.method === "HEAD" ? undefined : Buffer.from(await upstream.arrayBuffer()));
};

export const startPageServer = async (options: PageServerOptions) => {
  const { page } = options;
  const session = createPageSession(options.now);
  const dir = page.kind === "built" ? path.resolve(page.dir) : null;
  const document = dir === null ? null : await readFile(path.join(dir, "index.html"), "utf-8");
  let port = 0;

  const answerMain = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    origin: string,
  ) => {
    if (!session.signedIn(request.headers.cookie)) {
      refuse(response, 401, "This page is not signed in to IdleBiz: open IdleBiz again.");

      return;
    }

    const own = fromOwnOrigin({
      origin,
      originHeader: request.headers.origin,
      secFetchSite: onlyHeader(request, "sec-fetch-site"),
    });

    if (!own) {
      refuse(response, 403, "IdleBiz answers only its own page.");

      return;
    }

    if (!(await options.handleRpc(request, response))) {
      refuse(response, 404, `main answers no ${request.method ?? "request"} ${url.pathname}`);
    }
  };

  const answerPage = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    origin: string,
  ) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { ...BASE_HEADERS, allow: "GET, HEAD" });
      response.end();

      return;
    }

    const nonce = url.searchParams.get(HANDOFF_PARAM);

    if (nonce !== null) {
      url.searchParams.delete(HANDOFF_PARAM);
      const location = `${origin}${url.pathname}${url.search}`;
      const cookie = session.redeemHandoff(nonce);

      if (cookie === null) {
        response.writeHead(303, { ...BASE_HEADERS, location });
      } else {
        response.writeHead(303, { ...BASE_HEADERS, location, "set-cookie": cookie });
      }

      response.end();

      return;
    }

    const signedIn = session.signedIn(request.headers.cookie);

    if (page.kind === "dev") {
      if (signedIn) {
        await forward(page.origin, request, response, url);
      } else {
        signedOut(request, response);
      }

      return;
    }

    if (dir === null || document === null) {
      notFound(response);

      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (!signedIn) {
        signedOut(request, response);

        return;
      }

      response.writeHead(200, DOCUMENT_HEADERS);
      response.end(request.method === "HEAD" ? undefined : document);

      return;
    }

    await serveFile(dir, request, response, url.pathname);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const origin = loopbackOrigin(request.headers.host, port);

    if (origin === null) {
      response.writeHead(421, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" });
      response.end("IdleBiz answers only to 127.0.0.1 and localhost");

      return;
    }

    const url = new URL(request.url ?? "/", origin);
    await (url.pathname.startsWith(`${RPC_PREFIX}/`)
      ? answerMain(request, response, url, origin)
      : answerPage(request, response, url, origin));
  };

  const server = createServer((request, response) => {
    void (async () => {
      try {
        await handle(request, response);
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
        } else {
          refuse(response, 500, errorMessage(error));
        }
      }
    })();
  });

  port = await listenLoopback(server, "the page's server");
  live.add(port);
  const ownOrigin = `http://127.0.0.1:${port}`;

  let stopping: Promise<void> | null = null;

  return {
    handoff: () => ({
      handoffUrl: `${ownOrigin}/?${HANDOFF_PARAM}=${session.mintHandoff()}`,
      origin: ownOrigin,
    }),
    origin: ownOrigin,
    port,
    stop: async () => {
      stopping ??= (async () => {
        live.delete(port);
        const closed = once(server, "close");
        server.closeAllConnections();
        server.close();
        await closed;
      })();
      await stopping;
    },
  } satisfies PageServer;
};
