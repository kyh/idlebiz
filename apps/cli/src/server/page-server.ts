// The window's page, and main's door for it, on loopback: what kyh/inteligir's server answers its
// window (apps/cli/src/server/app.ts there). The shell opens its window on a one-time handoff link
// main mints when asked over stdio (`handoff`), the link signs the page in (page-session.ts), and the
// page then calls main (INVOKE_PATH) and hears its events (EVENTS_PATH) on its own origin: the
// window, a browser under `pnpm dev:browser` and e2e's Chromium alike. The page's files are the ones
// main ships beside it, or under `tauri dev` and `pnpm dev:browser` Vite's, forwarded so the page
// keeps this origin while it reloads in place.
//
// The founder's approve button is on this port. No employee run reaches it: the seal closes it to
// every run (`pagePorts`, agents/seal.ts). Of everyone else it answers only a request that names its
// own loopback host, and main's calls and events only for the page a handoff signed in, calling from
// its own origin.

import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";
import { z } from "zod";
import { listenLoopback } from "./lib/http";
import { createPageSession, fromOwnOrigin, loopbackOrigin } from "./page-session";
import { errorMessage } from "@repo/domain/errors";
import { jsonValueSchema, parseJson } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";
import { pagePolicy } from "./page-policy";
import { EVENTS_PATH, HANDOFF_PARAM, INVOKE_PATH, MAIN_PATHS } from "@repo/contract/page-routes";

/** Where the page's files come from: the built page main ships beside it, or Vite's dev server. */
export type PageSource = { kind: "built"; dir: string } | { kind: "dev"; origin: string };

export interface PageServerOptions {
  page: PageSource;
  /** Answers one of the page's calls with main's reply: its value, or the sentence it refused with. */
  dispatch: (method: string, payload: JsonValue | undefined) => Promise<JsonValue>;
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
  /** Tells every page listening. */
  broadcast: (channel: string, data: JsonValue) => void;
  /** Ends every event stream and stops answering. */
  stop: () => Promise<void>;
}

/** The largest call a page makes: a pasted key, a long answer to a question. */
const MAX_INVOKE_BYTES = 1024 * 1024;

const invokeSchema = z.object({ method: z.string().min(1), payload: jsonValueSchema.optional() });

// the page's files by type; the document is answered on its own, with the policy. A file of any
// other type is not the page's, and is not served
const FILE_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

// every answer's: each boot's page is on a port of its own, so nothing of it is worth keeping on
// disk for the next, and nothing is read as a type its header does not name
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

// what a page with no session gets in place of the office. The window never sees it, since the
// shell opens it signed in; a browser that came without a link does
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

// fetch has already undone the encoding these describe, and the connection is this server's own
const DROPPED_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

/** Every port a page server of main's answers on, which the seal closes to every run. */
const live = new Set<number>();

export const pagePorts = (): readonly number[] => [...live];

/**
 * The origin of a dev server main may take the page's files from: a loopback http one, as
 * `tauri dev` and `pnpm dev:browser` name Vite. Anything else is refused, since the page it answers
 * holds the founder's approve button.
 */
export const devPageOrigin = (url: string): string => {
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

/** A header the request carries once: none when it is missing, or sent more than once. */
const onlyHeader = (request: IncomingMessage, name: string): string | undefined => {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
};

const sendJson = (response: ServerResponse, status: number, body: JsonValue): void => {
  response.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const refuse = (response: ServerResponse, status: number, message: string): void => {
  sendJson(response, status, { message, ok: false });
};

const notFound = (response: ServerResponse): void => {
  response.writeHead(404, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
};

const signedOut = (request: IncomingMessage, response: ServerResponse): void => {
  response.writeHead(401, DOCUMENT_HEADERS);
  response.end(request.method === "HEAD" ? undefined : SIGNED_OUT_PAGE);
};

/** A call's body, or null for one past the cap, one that declares no length, or no call at all. */
const readInvoke = async (request: IncomingMessage) => {
  // node holds the body to the length it declares, so no bigger body is ever read; a page's fetch
  // of a string body always declares it
  const declared = Number(request.headers["content-length"]);
  if (!Number.isSafeInteger(declared) || declared > MAX_INVOKE_BYTES) {
    return null;
  }
  const body = await text(request);
  try {
    const parsed = invokeSchema.safeParse(parseJson(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** The page's file at `pathname`, or null for a name outside the page's folder. */
const fileUnder = (dir: string, pathname: string): string | null => {
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
): Promise<void> => {
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

/**
 * The file as Vite answers it, for the path and query the page asked this server for. The target is
 * Vite's origin with the path set on it, never the path resolved against it: `//host/x` would
 * resolve to another host. `/` there is `pnpm dev:browser`'s way in to this page, so the document
 * is asked for by name.
 */
const forward = async (
  origin: string,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> => {
  const target = new URL(origin);
  target.pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  target.search = url.search;
  const upstream = await fetch(target, {
    headers: { accept: onlyHeader(request, "accept") ?? "*/*" },
    method: request.method,
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

export const startPageServer = async (options: PageServerOptions): Promise<PageServer> => {
  const { page } = options;
  const session = createPageSession(options.now);
  const streams = new Set<ServerResponse>();
  const dir = page.kind === "built" ? path.resolve(page.dir) : null;
  // read once: the built page does not change under a running main
  const document = dir === null ? null : await readFile(path.join(dir, "index.html"), "utf-8");
  let port = 0;

  const invoke = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const call = await readInvoke(request);
    if (call === null) {
      refuse(response, 400, "a call is {method, payload?}, at most a megabyte");
      return;
    }
    sendJson(response, 200, await options.dispatch(call.method, call.payload));
  };

  const listen = (response: ServerResponse): void => {
    response.writeHead(200, {
      ...BASE_HEADERS,
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    response.write(": main's events\n\n");
    streams.add(response);
    response.once("close", () => {
      streams.delete(response);
    });
  };

  const answerMain = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    origin: string,
  ): Promise<void> => {
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
    if (url.pathname === INVOKE_PATH && request.method === "POST") {
      await invoke(request, response);
    } else if (url.pathname === EVENTS_PATH && request.method === "GET") {
      listen(response);
    } else {
      refuse(response, 404, `main answers no ${request.method ?? "request"} ${url.pathname}`);
    }
  };

  const answerPage = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    origin: string,
  ): Promise<void> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { ...BASE_HEADERS, allow: "GET, HEAD" });
      response.end();
      return;
    }
    const nonce = url.searchParams.get(HANDOFF_PARAM);
    if (nonce !== null) {
      // live or spent, the answer is the same page without the nonce, so it never lingers in the
      // history, and a reload lands a page that already holds its cookie
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
      // every file Vite answers needs the session: its `/@fs` reads any file of the checkout
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
    // the bundle's files are its public bytes; only the document, and main, need the session
    await serveFile(dir, request, response, url.pathname);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // first, ahead of every path: any name but this server's on loopback is a page that rebound its
    // own name onto 127.0.0.1
    const origin = loopbackOrigin(request.headers.host, port);
    if (origin === null) {
      response.writeHead(421, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" });
      response.end("IdleBiz answers only to 127.0.0.1 and localhost");
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    await (url.pathname.startsWith(MAIN_PATHS)
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
  port = await listenLoopback(server);
  live.add(port);
  const ownOrigin = `http://127.0.0.1:${port}`;

  let stopping: Promise<void> | null = null;
  return {
    broadcast: (channel, data) => {
      const frame = `event: ${channel}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const stream of streams) {
        stream.write(frame);
      }
    },
    handoff: () => ({
      handoffUrl: `${ownOrigin}/?${HANDOFF_PARAM}=${session.mintHandoff()}`,
      origin: ownOrigin,
    }),
    origin: ownOrigin,
    port,
    stop: async () => {
      stopping ??= (async () => {
        live.delete(port);
        for (const stream of streams) {
          stream.end();
        }
        streams.clear();
        const closed = once(server, "close");
        // the event streams hold their connections open
        server.closeAllConnections();
        server.close();
        await closed;
      })();
      await stopping;
    },
  };
};
