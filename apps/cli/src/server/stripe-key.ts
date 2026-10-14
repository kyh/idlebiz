import { getJson } from "./lib/http";
import type { VendorFault } from "./lib/vendor-call";
import { STRIPE_SECRET_KEY, deleteSecret, getSecret, setSecret } from "./secrets";
import { STRIPE_API, answeringStripe, isTestKey, stripeHeaders } from "./stripe-api";
import type { StripeKeyStatus } from "@repo/domain/integrations";
import { forgetStripeRead } from "./metrics";
import type { StripeAnswer } from "./metrics";
import { RefusalError } from "./refusal";

// The founder's own key charges and reads revenue; the renderer is told which key is saved,
// never the key.

/**
 * A key that works server-side: a secret key does anything, a restricted one what it was granted.
 * Stripe keys are base62; anything else pasted in (a NUL, a zero-width space) would fail in the
 * Authorization header before Stripe is asked, and fetch's refusal quotes the whole key.
 */
const SERVER_KEY = /^[rs]k_(?:live|test)_[0-9A-Za-z]+$/u;

// Stripe grants read with write, so any key that can make payment links can list
// them; /v1/account would turn away a restricted key granted only what charging needs.
const PROBE = `${STRIPE_API}/v1/payment_links?limit=1`;

/** The saved key the metrics pulse last found Stripe turning away, until a read Stripe takes it or it is saved again. */
let refusedKey: string | null = null;

/** What the metrics pulse's read of `key` says of it; a refusal shows without deleting the key. */
export const noteStripeRead = (key: string, answer: StripeAnswer): void => {
  if (answer === "refused") {
    refusedKey = key;
  } else if (answer === "accepted") {
    refusedKey = null;
  }
};

export const stripeKeyStatus = (): StripeKeyStatus => {
  const key = getSecret(STRIPE_SECRET_KEY);
  if (!key) {
    return { state: "unset" };
  }
  const last4 = key.slice(-4);
  const livemode = !isTestKey(key);
  return key === refusedKey
    ? { last4, livemode, state: "refused" }
    : { last4, livemode, state: "set" };
};

/** Why Stripe did not take a key, as the founder should read it. */
const turnedAway = (fault: VendorFault): string => {
  if (fault.kind !== "refused") {
    return `Stripe couldn't check this key (${fault.reason}) — nothing was saved; try again.`;
  }
  return fault.status === 401
    ? "Stripe doesn't recognise this key — copy it again from the API keys page of your Stripe Dashboard."
    : "Stripe won't let this key make payment links — give the restricted key Write on Payment Links, Prices, Products and Shipping Rates and Read on Charges and Checkout Sessions, or use your secret key.";
};

/** Keep `key` once Stripe has taken it; refused, nothing is saved. */
export const saveStripeKey = async (key: string): Promise<void> => {
  if (!SERVER_KEY.test(key)) {
    throw new RefusalError(
      "That isn't a secret key — paste one that starts sk_ or rk_ from the API keys page of your Stripe Dashboard, not the publishable pk_ one.",
    );
  }
  const probed = await answeringStripe("key check", () => getJson(PROBE, stripeHeaders(key)));
  if (probed.kind !== "ok") {
    throw new RefusalError(turnedAway(probed));
  }
  setSecret(STRIPE_SECRET_KEY, key);
  // A restricted key's grants are edited in place, so the key the pulse found refused may be
  // pasted again once it is granted Read on Charges: what was read of it no longer stands.
  refusedKey = null;
  forgetStripeRead();
};

export const removeStripeKey = (): void => {
  deleteSecret(STRIPE_SECRET_KEY);
};
