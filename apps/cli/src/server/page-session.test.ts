import { describe, expect, it } from "vitest";
import {
  HANDOFF_TTL_MS,
  SESSION_COOKIE,
  createPageSession,
  fromOwnOrigin,
  loopbackOrigin,
} from "./page-session";

const cookieOf = (setCookie: string | null): string => {
  const pair = setCookie?.split(";")[0];
  if (pair === undefined) {
    throw new Error("the handoff set no cookie");
  }
  return pair;
};

describe("the page's session", () => {
  it("signs a page in once per handoff, with a cookie no script reads", () => {
    const session = createPageSession();
    const nonce = session.mintHandoff();
    const setCookie = session.redeemHandoff(nonce);
    expect(setCookie).toMatch(
      new RegExp(`^${SESSION_COOKIE}=[\\w-]+; HttpOnly; SameSite=Strict; Path=/$`, "u"),
    );
    expect(session.redeemHandoff(nonce)).toBeNull();
    expect(session.signedIn(cookieOf(setCookie))).toBe(true);
    expect(session.signedIn(`theme=dark; ${cookieOf(setCookie)}`)).toBe(true);
  });

  it("lets a handoff die unspent after five minutes", () => {
    let now = 1000;
    const session = createPageSession(() => now);
    const nonce = session.mintHandoff();
    now += HANDOFF_TTL_MS;
    expect(session.redeemHandoff(nonce)).toBeNull();
  });

  it("knows no nonce it never minted, and no other boot's session", () => {
    const session = createPageSession();
    const other = createPageSession();
    expect(session.redeemHandoff("made-up")).toBeNull();
    expect(session.signedIn(cookieOf(other.redeemHandoff(other.mintHandoff())))).toBe(false);
    expect(session.signedIn()).toBe(false);
    expect(session.signedIn(`${SESSION_COOKIE}=`)).toBe(false);
  });
});

describe("who a request may come from", () => {
  it("names this server's own loopback host, and only that", () => {
    expect(loopbackOrigin("127.0.0.1:5100", 5100)).toBe("http://127.0.0.1:5100");
    expect(loopbackOrigin("localhost:5100", 5100)).toBe("http://localhost:5100");
    for (const host of ["127.0.0.1:5101", "evil.example:5100", "127.0.0.1", ""]) {
      expect(loopbackOrigin(host, 5100)).toBeNull();
    }
  });

  it("takes a call from the page's own origin alone", () => {
    const origin = "http://127.0.0.1:5100";
    const from = (headers: { secFetchSite?: string; originHeader?: string }) =>
      fromOwnOrigin({ origin, ...headers });
    expect(from({ secFetchSite: "same-origin" })).toBe(true);
    expect(from({ secFetchSite: "none" })).toBe(true);
    // another 127.0.0.1 port is the same site, and carries the cookie
    expect(from({ originHeader: origin, secFetchSite: "same-site" })).toBe(false);
    expect(from({ originHeader: origin, secFetchSite: "cross-site" })).toBe(false);
    expect(from({ originHeader: origin })).toBe(true);
    expect(from({ originHeader: "http://127.0.0.1:5101" })).toBe(false);
    expect(from({})).toBe(false);
  });
});
