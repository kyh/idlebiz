import { z } from "zod";

// ---------------------------------------------------------------------------
// The handshake between idlebiz.com and the desktop app.
//
// The desktop opens the site's authorize route with a state naming its
// ephemeral loopback port and a nonce; after the founder approves on Stripe,
// the site's callback exchanges the code (the platform secret never leaves
// the server) and redirects the outcome to the desktop's loopback server. The
// desktop later asks the site to deauthorize. Every field either side reads
// is declared here, once, so a rename is a type error and not a silent
// failure across the seam.
// ---------------------------------------------------------------------------

export const AUTHORIZE_PATH = "/api/stripe/authorize";
export const CALLBACK_PATH = "/api/stripe/callback";
export const DEAUTHORIZE_PATH = "/api/stripe/deauthorize";
/** Where the desktop's loopback server listens for the outcome. */
export const LOOPBACK_CALLBACK_PATH = "/stripe/callback";

export const OAuthStateSchema = z.object({
  port: z.number().int().min(1024).max(65535),
  nonce: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export type OAuthState = z.infer<typeof OAuthStateSchema>;

/** The state as Stripe carries it through the flow: base64url of the validated fields. */
export function encodeState(state: OAuthState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

export function parseState(raw: string | null): OAuthState | null {
  if (!raw || raw.length > 256) return null;
  try {
    const decoded = OAuthStateSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return decoded.success ? decoded.data : null;
  } catch {
    return null;
  }
}

/** What the site tells the desktop: a connected account, or why there is none. */
export type CallbackOutcome =
  | { kind: "connected"; accessToken: string; stripeUserId: string; livemode: boolean }
  | { kind: "failed"; error: string };

const callbackQuerySchema = z.object({
  nonce: z.string(),
  error: z.string().optional(),
  access_token: z.string().optional(),
  stripe_user_id: z.string().optional(),
  livemode: z.enum(["true", "false"]).optional(),
});

/** The desktop's loopback URL carrying the outcome for `state`. */
export function loopbackUrl(state: OAuthState, outcome: CallbackOutcome): string {
  const query = new URLSearchParams({ nonce: state.nonce });
  if (outcome.kind === "failed") query.set("error", outcome.error);
  else {
    query.set("access_token", outcome.accessToken);
    query.set("stripe_user_id", outcome.stripeUserId);
    query.set("livemode", String(outcome.livemode));
  }
  return `http://127.0.0.1:${state.port}${LOOPBACK_CALLBACK_PATH}?${query.toString()}`;
}

/** The outcome the loopback server was handed, or null when the query is not one. */
export function parseCallback(
  params: URLSearchParams,
): { nonce: string; outcome: CallbackOutcome } | null {
  const query = callbackQuerySchema.safeParse(Object.fromEntries(params));
  if (!query.success) return null;
  const { nonce, error, access_token, stripe_user_id, livemode } = query.data;
  if (error !== undefined) return { nonce, outcome: { kind: "failed", error } };
  if (access_token === undefined || stripe_user_id === undefined) {
    return { nonce, outcome: { kind: "failed", error: "missing_token" } };
  }
  return {
    nonce,
    outcome: {
      kind: "connected",
      accessToken: access_token,
      stripeUserId: stripe_user_id,
      livemode: livemode === "true",
    },
  };
}

export function authorizeUrl(webBase: string, state: OAuthState): string {
  return `${webBase}${AUTHORIZE_PATH}?state=${encodeState(state)}`;
}

export const DeauthorizeBodySchema = z.object({
  accessToken: z.string(),
  stripeUserId: z.string(),
});
export type DeauthorizeBody = z.infer<typeof DeauthorizeBodySchema>;
