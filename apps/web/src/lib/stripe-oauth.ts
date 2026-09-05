// Stripe Connect OAuth, site side. The desktop opens /api/stripe/authorize
// with a state naming its loopback port; after the founder approves on Stripe,
// /api/stripe/callback exchanges the code here (the platform secret never
// leaves the server) and forwards the read-only connected-account token to the
// desktop. The handshake's shapes live in @repo/stripe-connect-protocol.

import { z } from "zod";
import { env } from "@/lib/env";

const tokenResponseSchema = z.object({
  access_token: z.string(),
  stripe_user_id: z.string(),
  livemode: z.boolean().catch(false),
});

const tokenErrorSchema = z.object({ error_description: z.string() });

export interface ExchangeResult {
  accessToken: string;
  stripeUserId: string;
  livemode: boolean;
}

/** POST connect.stripe.com/oauth/token with the platform secret. */
export async function exchangeCode(code: string): Promise<ExchangeResult> {
  const secret = env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("STRIPE_SECRET_KEY not configured");
  const res = await fetch("https://connect.stripe.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_secret: secret,
    }),
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
    stripeUserId: token.data.stripe_user_id,
    livemode: token.data.livemode,
  };
}

const accountResponseSchema = z.object({ id: z.string() });

/** The account id the token actually belongs to (ownership check for deauthorize). */
export async function tokenAccountId(accessToken: string): Promise<string | null> {
  const res = await fetch("https://api.stripe.com/v1/account", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const account = accountResponseSchema.safeParse(await res.json());
  return account.success ? account.data.id : null;
}

export async function deauthorize(stripeUserId: string): Promise<void> {
  const secret = env.STRIPE_SECRET_KEY;
  const clientId = env.STRIPE_CLIENT_ID;
  if (!secret || !clientId) throw new Error("Stripe platform env not configured");
  const res = await fetch("https://connect.stripe.com/oauth/deauthorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${secret}`,
    },
    body: new URLSearchParams({ client_id: clientId, stripe_user_id: stripeUserId }),
  });
  if (!res.ok) throw new Error(`deauthorize failed (${res.status})`);
}
