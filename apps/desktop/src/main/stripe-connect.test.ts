import { channel } from "node:diagnostics_channel";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loopbackUrl, parseState } from "@repo/stripe-connect-protocol/protocol";
import type { OAuthState } from "@repo/stripe-connect-protocol/protocol";
import { seal } from "@repo/stripe-connect-protocol/seal";
import type { StripeStatus } from "@/shared/integrations";
import { listenLoopback } from "./lib/http";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-stripe-"));
const previous = {
  IDLEBIZ_ROOT_DIR: process.env["IDLEBIZ_ROOT_DIR"],
  IDLEBIZ_WEB_URL: process.env["IDLEBIZ_WEB_URL"],
  STRIPE_CONNECT_TOKEN: process.env["STRIPE_CONNECT_TOKEN"],
};
process.env["IDLEBIZ_ROOT_DIR"] = root;
let holdRevocation: ((res: ServerResponse) => void) | null = null;
const web = createServer((req, res) => {
  req.resume();
  if (holdRevocation) {
    holdRevocation(res);
  } else {
    res.writeHead(200).end();
  }
});
const port = await listenLoopback(web);
process.env["IDLEBIZ_WEB_URL"] = `http://127.0.0.1:${port}`;
const stripe = await import("./stripe-connect");
const store = await import("./store/store");
const { getSecret } = await import("./secrets");
store.initStore();
const company = store.foundCompany({
  budget: { capUsd: 0, mode: "capped" },
  businessType: "software",
  founderName: "Fixture",
  founderSpriteSeed: "fixture",
  hires: [],
  mission: "test",
  name: "Stripe fixture",
});
const urls: string[] = [];
const connected: string[] = [];
const notified: StripeStatus[] = [];
stripe.initStripeConnect({
  notify: (status) => notified.push(status),
  onConnected: (id) => connected.push(id),
  openExternal: (url) => {
    urls.push(url);
    return Promise.resolve();
  },
});
beforeEach(() => {
  urls.length = 0;
  connected.length = 0;
  notified.length = 0;
});
afterEach(async () => {
  holdRevocation = null;
  await stripe.disconnectStripe(company.id);
});
afterAll(async () => {
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
  await new Promise<void>((resolve, reject) => {
    web.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(root, { force: true, recursive: true });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stringifies an assigned undefined; delete is the only unset
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const latestState = (): OAuthState => {
  const url = urls.at(-1);
  const state = url ? parseState(new URL(url).searchParams.get("state")) : null;
  if (!state) {
    throw new Error("no valid authorization URL opened");
  }
  return state;
};

const callbackUrl = async (state: OAuthState, token: string): Promise<string> => {
  const sealed = await seal(state.key, {
    accessToken: token,
    livemode: false,
    stripeUserId: "acct_fixture",
  });
  return loopbackUrl(state, { kind: "sealed", sealed });
};

const connectThenDisconnect = async (answer: (res: ServerResponse) => void): Promise<void> => {
  await stripe.beginConnect(company.id);
  const response = await fetch(await callbackUrl(latestState(), "token-connected"));
  await response.text();
  holdRevocation = answer;
  await stripe.disconnectStripe(company.id);
};

describe("Stripe flow ownership", () => {
  it("opens only the latest startup and completes its real encrypted callback", async () => {
    const results = await Promise.all([
      stripe.beginConnect(company.id),
      stripe.beginConnect(company.id),
    ]);
    expect(results).toEqual([{ started: false }, { started: true }]);
    expect(urls).toHaveLength(1);
    const response = await fetch(await callbackUrl(latestState(), "token-latest"));
    expect(await response.text()).toContain("Stripe connected");
    expect(getSecret("STRIPE_CONNECT_TOKEN")).toBe("token-latest");
    expect(connected).toEqual([company.id]);
  });

  it("does not reconnect when cancelled during callback decryption", async () => {
    await stripe.beginConnect(company.id);
    const url = new URL(await callbackUrl(latestState(), "token-cancelled"));
    const cancelled = Promise.withResolvers<null>();
    const requests = channel("http.server.request.start");
    const onRequest: Parameters<typeof requests.subscribe>[0] = (message) => {
      const event = z.object({ request: z.instanceof(IncomingMessage) }).safeParse(message);
      if (!event.success || event.data.request.socket.localPort !== Number(url.port)) {
        return;
      }
      requests.unsubscribe(onRequest);
      // Run after the HTTP handler reaches its first WebCrypto await, before decryption resumes.
      queueMicrotask(() => {
        void stripe
          .disconnectStripe(company.id)
          .then(() => cancelled.resolve(null), cancelled.reject);
      });
    };
    requests.subscribe(onRequest);
    try {
      const response = await fetch(url);
      expect(await response.text()).toContain("Stripe connection failed");
      await cancelled.promise;
      expect(getSecret("STRIPE_CONNECT_TOKEN")).toBeNull();
      expect(stripe.getStripeStatus(company.id)).toEqual({ state: "disconnected" });
      expect(connected).toEqual([]);
    } finally {
      requests.unsubscribe(onRequest);
    }
  });

  it("waits for account revocation before opening a replacement authorization", async () => {
    await stripe.beginConnect(company.id);
    const response = await fetch(await callbackUrl(latestState(), "token-old"));
    await response.text();
    const received = Promise.withResolvers<ServerResponse>();
    holdRevocation = received.resolve;
    const disconnect = stripe.disconnectStripe(company.id);
    const revocation = await received.promise;
    const reconnect = stripe.beginConnect(company.id);
    try {
      expect(getSecret("STRIPE_CONNECT_TOKEN")).toBeNull();
      expect(urls).toHaveLength(1);
      revocation.writeHead(200).end();
      await disconnect;
      expect(await reconnect).toEqual({ started: true });
      expect(urls).toHaveLength(2);
      holdRevocation = null;
      const replacement = await fetch(await callbackUrl(latestState(), "token-new"));
      await replacement.text();
      expect(getSecret("STRIPE_CONNECT_TOKEN")).toBe("token-new");
    } finally {
      holdRevocation = null;
      revocation.end();
      await Promise.all([disconnect, reconnect]);
    }
  });
});

describe("Stripe disconnect", () => {
  it("reads a revoked grant, or one the token can no longer read, as disconnected", async () => {
    for (const status of [200, 403]) {
      await connectThenDisconnect((res) => res.writeHead(status).end());
      expect(getSecret("STRIPE_CONNECT_TOKEN"), String(status)).toBeNull();
      expect(stripe.getStripeStatus(company.id), String(status)).toEqual({
        state: "disconnected",
      });
    }
  });

  it("tells the founder when Stripe did not confirm the revocation", async () => {
    await connectThenDisconnect((res) => res.writeHead(502).end());
    expect(getSecret("STRIPE_CONNECT_TOKEN")).toBeNull();
    expect(stripe.getStripeStatus(company.id)).toEqual({
      message:
        "Disconnected here, but Stripe may still list IdleBiz (HTTP 502) — remove it under Installed apps in your Stripe Dashboard.",
      state: "error",
    });
  });

  it("tells the founder when the revocation never reached Stripe", async () => {
    await connectThenDisconnect((res) => res.destroy());
    expect(getSecret("STRIPE_CONNECT_TOKEN")).toBeNull();
    expect(stripe.getStripeStatus(company.id).state).toBe("error");
  });

  it("keeps quiet about an unconfirmed revocation once the founder reconnects", async () => {
    const received = Promise.withResolvers<ServerResponse>();
    const disconnect = connectThenDisconnect(received.resolve);
    const revocation = await received.promise;
    const reconnect = stripe.beginConnect(company.id);
    revocation.writeHead(502).end();
    await disconnect;
    expect(await reconnect).toEqual({ started: true });
    expect(notified.map(({ state }) => state)).toEqual([
      "connecting",
      "connected",
      "disconnected",
      "connecting",
    ]);
  });
});
