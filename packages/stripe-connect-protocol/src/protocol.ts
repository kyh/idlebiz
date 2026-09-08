import { z } from "zod";
import { PublicKeySchema } from "./seal";

// The site exchanges Stripe's code and seals the account to the desktop's
// one-flow public key. Only that envelope returns through the loopback callback.

export const AUTHORIZE_PATH = "/api/stripe/authorize";
export const CALLBACK_PATH = "/api/stripe/callback";
export const DEAUTHORIZE_PATH = "/api/stripe/deauthorize";
/** Where the desktop's loopback server listens for the outcome. */
export const LOOPBACK_CALLBACK_PATH = "/stripe/callback";

export const OAuthStateSchema = z.object({
  /** The desktop's public key for this flow; the account comes back sealed to it. */
  key: PublicKeySchema,
  nonce: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u),
  port: z.number().int().min(1024).max(65_535),
});
export type OAuthState = z.infer<typeof OAuthStateSchema>;

/** The state as Stripe carries it through the flow: base64url of the validated fields. */
export const encodeState = (state: OAuthState): string =>
  Buffer.from(JSON.stringify(state), "utf-8").toString("base64url");

export const parseState = (raw: string | null): OAuthState | null => {
  if (!raw || raw.length > 512) {
    return null;
  }
  try {
    const decoded = OAuthStateSchema.safeParse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf-8")),
    );
    return decoded.success ? decoded.data : null;
  } catch {
    return null;
  }
};

export const ConnectedAccountSchema = z.object({
  accessToken: z.string().min(1),
  livemode: z.boolean(),
  stripeUserId: z.string().min(1),
});
export type ConnectedAccount = z.infer<typeof ConnectedAccountSchema>;

export type CallbackOutcome =
  | { kind: "sealed"; sealed: string }
  | { kind: "failed"; error: string };

const callbackQuerySchema = z.object({
  error: z.string().optional(),
  nonce: z.string(),
  sealed: z.string().optional(),
});

export const loopbackUrl = (state: OAuthState, outcome: CallbackOutcome): string => {
  const query = new URLSearchParams({ nonce: state.nonce });
  if (outcome.kind === "failed") {
    query.set("error", outcome.error);
  } else {
    query.set("sealed", outcome.sealed);
  }
  return `http://127.0.0.1:${state.port}${LOOPBACK_CALLBACK_PATH}?${query.toString()}`;
};

export const parseCallback = (
  params: URLSearchParams,
): { nonce: string; outcome: CallbackOutcome } | null => {
  const query = callbackQuerySchema.safeParse(Object.fromEntries(params));
  if (!query.success) {
    return null;
  }
  const { nonce, error, sealed } = query.data;
  if (error !== undefined) {
    return { nonce, outcome: { error, kind: "failed" } };
  }
  if (sealed === undefined) {
    return { nonce, outcome: { error: "missing_envelope", kind: "failed" } };
  }
  return { nonce, outcome: { kind: "sealed", sealed } };
};

export const authorizeUrl = (webBase: string, state: OAuthState): string =>
  `${webBase}${AUTHORIZE_PATH}?state=${encodeState(state)}`;

export const DeauthorizeBodySchema = z.object({
  accessToken: z.string(),
  stripeUserId: z.string(),
});
export type DeauthorizeBody = z.infer<typeof DeauthorizeBodySchema>;
