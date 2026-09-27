// Exchange codes on the server so the platform secret never reaches the desktop.
import { z } from "zod";
import { env } from "@/lib/env";
import type { ConnectedAccount } from "@repo/stripe-connect-protocol/protocol";

const tokenResponseSchema = z.object({
  access_token: z.string(),
  // oxlint-disable-next-line promise/prefer-await-to-then -- zod's .catch, not a promise
  livemode: z.boolean().catch(false),
  stripe_user_id: z.string(),
});

const tokenErrorSchema = z.object({ error_description: z.string() });

export const exchangeCode = async (code: string): Promise<ConnectedAccount> => {
  const secret = env.STRIPE_SECRET_KEY;
  if (!secret) {
    throw new Error("STRIPE_SECRET_KEY not configured");
  }
  const res = await fetch("https://connect.stripe.com/oauth/token", {
    body: new URLSearchParams({
      client_secret: secret,
      code,
      grant_type: "authorization_code",
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const data: unknown = await res.json();
  if (!res.ok) {
    const failure = tokenErrorSchema.safeParse(data);
    throw new Error(
      failure.success ? failure.data.error_description : `token exchange failed (${res.status})`,
    );
  }
  const token = tokenResponseSchema.safeParse(data);
  if (!token.success) {
    throw new Error("token exchange returned an unexpected shape");
  }
  return {
    accessToken: token.data.access_token,
    livemode: token.data.livemode,
    stripeUserId: token.data.stripe_user_id,
  };
};

const accountResponseSchema = z.object({ id: z.string() });

export type TokenOwner =
  | { kind: "account"; id: string }
  | { kind: "dead" }
  | { kind: "unreadable"; reason: string };

/**
 * The account the token actually belongs to (ownership check for deauthorize).
 * Only a 401 means the token is dead: a rate limit or outage says nothing about
 * the grant, and the desktop reads "dead" as nothing left to revoke.
 */
export const tokenOwner = async (accessToken: string): Promise<TokenOwner> => {
  const res = await fetch("https://api.stripe.com/v1/account", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) {
    return { kind: "dead" };
  }
  if (!res.ok) {
    return { kind: "unreadable", reason: `account lookup failed (${res.status})` };
  }
  const account = accountResponseSchema.safeParse(await res.json());
  return account.success
    ? { id: account.data.id, kind: "account" }
    : { kind: "unreadable", reason: "account lookup returned an unexpected shape" };
};

export const deauthorize = async (stripeUserId: string): Promise<void> => {
  const secret = env.STRIPE_SECRET_KEY;
  const clientId = env.STRIPE_CLIENT_ID;
  if (!secret || !clientId) {
    throw new Error("Stripe platform env not configured");
  }
  const res = await fetch("https://connect.stripe.com/oauth/deauthorize", {
    body: new URLSearchParams({ client_id: clientId, stripe_user_id: stripeUserId }),
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`deauthorize failed (${res.status})`);
  }
};
