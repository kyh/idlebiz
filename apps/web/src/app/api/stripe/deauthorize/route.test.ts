import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "@/lib/env";

import { POST } from "./route";

const ACCOUNT = "acct_founder";

const stripeAnswering = (accountStatus: number) => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: string) => {
    calls.push(input);
    if (input !== "https://api.stripe.com/v1/account") {
      return Promise.resolve(Response.json({ stripe_user_id: ACCOUNT }));
    }
    return Promise.resolve(
      accountStatus === 200
        ? Response.json({ id: ACCOUNT })
        : Response.json({ error: { message: "nope" } }, { status: accountStatus }),
    );
  });
  return calls;
};

const disconnect = () =>
  POST(
    new Request("https://idlebiz.com/api/stripe/deauthorize", {
      body: JSON.stringify({ accessToken: "rk_live_x", stripeUserId: ACCOUNT }),
      method: "POST",
    }),
  );

describe("POST /api/stripe/deauthorize", () => {
  const platform = { ...env };

  beforeEach(() => {
    env.STRIPE_CLIENT_ID = "ca_x";
    env.STRIPE_SECRET_KEY = "sk_x";
  });

  afterEach(() => {
    Object.assign(env, platform);
    vi.unstubAllGlobals();
  });

  it("revokes the grant when the token reads its own account", async () => {
    const calls = stripeAnswering(200);
    const res = await disconnect();
    expect(res.status).toBe(200);
    expect(calls).toContain("https://connect.stripe.com/oauth/deauthorize");
  });

  it("answers 403 only when Stripe says the token is dead", async () => {
    stripeAnswering(401);
    const { status } = await disconnect();
    expect(status).toBe(403);
  });

  it.each([429, 503])(
    "answers 502 when Stripe fails with %i, so the desktop warns",
    async (failure) => {
      const calls = stripeAnswering(failure);
      const { status } = await disconnect();
      expect(status).toBe(502);
      expect(calls).not.toContain("https://connect.stripe.com/oauth/deauthorize");
    },
  );
});
