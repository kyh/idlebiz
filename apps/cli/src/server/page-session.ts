// The window's sign-in to main's page server, as kyh/inteligir's browser session signs its window in
// (apps/cli/src/server/browser-session.ts there): one secret per boot, which the page holds in an
// HttpOnly, SameSite=Strict cookie that only a one-time handoff sets. Main mints a handoff when the
// shell (or the dev host) asks for one over stdio, and the shell opens its window on it. The nonce
// rides a URL, so it is spent at its first use and dies unspent after five minutes.

import { randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "idlebiz_session";
export const HANDOFF_TTL_MS = 5 * 60_000;
const SECRET_BYTES = 32;

const mintSecret = (): string => randomBytes(SECRET_BYTES).toString("base64url");

const sameSecret = (presented: string, secret: string): boolean => {
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Every value a Cookie header carries under `name`: a browser sends one per path that set it. */
const cookieValues = (header: string | undefined, name: string): string[] =>
  (header ?? "").split(";").flatMap((pair) => {
    const at = pair.indexOf("=");
    return at !== -1 && pair.slice(0, at).trim() === name ? [pair.slice(at + 1).trim()] : [];
  });

export interface PageSession {
  /** Whether a request's Cookie header carries this boot's session. */
  signedIn: (cookieHeader?: string) => boolean;
  /** A nonce for a handoff link: good once, for five minutes. */
  mintHandoff: () => string;
  /** The Set-Cookie that signs the page in, once per nonce; null for one spent, expired or never minted. */
  redeemHandoff: (nonce: string) => string | null;
}

export const createPageSession = (now: () => number = Date.now): PageSession => {
  const secret = mintSecret();
  const handoffs = new Map<string, number>();
  const dropExpired = (): void => {
    const at = now();
    for (const [nonce, expires] of handoffs) {
      if (expires <= at) {
        handoffs.delete(nonce);
      }
    }
  };
  return {
    mintHandoff: () => {
      dropExpired();
      const nonce = mintSecret();
      handoffs.set(nonce, now() + HANDOFF_TTL_MS);
      return nonce;
    },
    redeemHandoff: (nonce) => {
      dropExpired();
      return handoffs.delete(nonce)
        ? `${SESSION_COOKIE}=${secret}; HttpOnly; SameSite=Strict; Path=/`
        : null;
    },
    signedIn: (cookieHeader) =>
      cookieValues(cookieHeader, SESSION_COOKIE).some((value) => sameSecret(value, secret)),
  };
};

/**
 * The page's origin as a request names it, or null for any host but this server's on loopback: the
 * server binds 127.0.0.1, so another name is a page that rebound its own name onto this port. The
 * header, never the URL, which node builds from it.
 */
export const loopbackOrigin = (host: string | undefined, port: number): string | null =>
  host === `127.0.0.1:${port}` || host === `localhost:${port}` ? `http://${host}` : null;

/**
 * Whether a request carrying the session came from the page's own origin. The cookie is ambient, and
 * loopback's "site" ignores the port, so a page on another 127.0.0.1 port sends it too. Fetch
 * metadata says where a request came from when the browser sends it (WebKit and Chromium both do);
 * else the Origin header must be this origin.
 */
export const fromOwnOrigin = (request: {
  origin: string;
  originHeader?: string | undefined;
  secFetchSite?: string | undefined;
}): boolean =>
  request.secFetchSite === undefined
    ? request.originHeader === request.origin
    : request.secFetchSite === "same-origin" || request.secFetchSite === "none";
