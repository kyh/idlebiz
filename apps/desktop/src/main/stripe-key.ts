import { HttpError, getJson } from "@/main/lib/http";
import { STRIPE_VERSION, isTestKey } from "@/main/metrics";
import { STRIPE_SECRET_KEY, deleteSecret, getSecret, setSecret } from "@/main/secrets";
import { errorMessage } from "@/shared/errors";
import type { StripeKeyStatus } from "@/shared/integrations";
import { RefusalError } from "@/shared/refusal";

// A Connect token only reads, so charging takes the founder's own key; the renderer
// is told which key is saved, never the key.

/**
 * A key that works server-side: a secret key does anything, a restricted one what it was granted.
 * Stripe keys are base62; anything else pasted in (a NUL, a zero-width space) would fail in the
 * Authorization header before Stripe is asked, and fetch's refusal quotes the whole key.
 */
const SERVER_KEY = /^[rs]k_(?:live|test)_[0-9A-Za-z]+$/u;

// Stripe grants read with write, so any key that can make payment links can list
// them; /v1/account would turn away a restricted key granted only what charging needs.
const PROBE = "https://api.stripe.com/v1/payment_links?limit=1";

export const stripeKeyStatus = (): StripeKeyStatus => {
  const key = getSecret(STRIPE_SECRET_KEY);
  return key
    ? { last4: key.slice(-4), livemode: !isTestKey(key), state: "set" }
    : { state: "unset" };
};

/** Why Stripe turned a key away, as the founder should read it. */
const turnedAway = (status: number): string => {
  switch (status) {
    case 401: {
      return "Stripe doesn't recognise this key — copy it again from the API keys page of your Stripe Dashboard.";
    }
    case 403: {
      return "Stripe won't let this key make payment links — give the restricted key Write on Payment Links, Prices and Products and Read on Charges and Customers, or use your secret key.";
    }
    default: {
      return `Stripe answered ${status} — nothing was saved; try again.`;
    }
  }
};

/** Keep `key` once Stripe has taken it; refused, nothing is saved. */
export const saveStripeKey = async (key: string): Promise<void> => {
  if (!SERVER_KEY.test(key)) {
    throw new RefusalError(
      "That isn't a secret key — paste one that starts sk_ or rk_ from the API keys page of your Stripe Dashboard, not the publishable pk_ one.",
    );
  }
  try {
    await getJson(PROBE, { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION });
  } catch (error) {
    throw new RefusalError(
      error instanceof HttpError
        ? turnedAway(error.status)
        : `Stripe couldn't be reached (${errorMessage(error)}) — nothing was saved; try again.`,
    );
  }
  setSecret(STRIPE_SECRET_KEY, key);
};

export const removeStripeKey = (): void => {
  deleteSecret(STRIPE_SECRET_KEY);
};
