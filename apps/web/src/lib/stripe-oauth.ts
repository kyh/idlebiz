// Stripe Connect OAuth plumbing for the desktop app. The desktop opens
// /api/stripe/authorize with state = base64url({port, nonce}); after the
// founder approves on Stripe, /api/stripe/callback exchanges the code here
// (the platform secret never leaves the server) and forwards the read-only
// connected-account token to the desktop's loopback server on 127.0.0.1:port.

import { env } from "@/lib/env";

export interface OAuthState {
  port: number;
  nonce: string;
}

export function parseState(raw: string | null): OAuthState | null {
  if (!raw || raw.length > 256) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object") return null;
    const o = decoded as { port?: unknown; nonce?: unknown };
    if (typeof o.port !== "number" || !Number.isInteger(o.port) || o.port < 1024 || o.port > 65535)
      return null;
    if (typeof o.nonce !== "string" || o.nonce.length < 16 || o.nonce.length > 128) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(o.nonce)) return null;
    return { port: o.port, nonce: o.nonce };
  } catch {
    return null;
  }
}

export function loopbackUrl(state: OAuthState, params: Record<string, string>): string {
  const qs = new URLSearchParams({ nonce: state.nonce, ...params });
  return `http://127.0.0.1:${state.port}/stripe/callback?${qs.toString()}`;
}

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
  if (!res.ok || !data || typeof data !== "object") {
    const message =
      data && typeof data === "object" && "error_description" in data
        ? String((data as { error_description: unknown }).error_description)
        : `token exchange failed (${res.status})`;
    throw new Error(message);
  }
  const o = data as { access_token?: unknown; stripe_user_id?: unknown; livemode?: unknown };
  if (typeof o.access_token !== "string" || typeof o.stripe_user_id !== "string") {
    throw new Error("token exchange returned an unexpected shape");
  }
  return {
    accessToken: o.access_token,
    stripeUserId: o.stripe_user_id,
    livemode: o.livemode === true,
  };
}

/** The account id the token actually belongs to (ownership check for deauthorize). */
export async function tokenAccountId(accessToken: string): Promise<string | null> {
  const res = await fetch("https://api.stripe.com/v1/account", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data: unknown = await res.json();
  if (data && typeof data === "object" && "id" in data) {
    const id = (data as { id: unknown }).id;
    if (typeof id === "string") return id;
  }
  return null;
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
