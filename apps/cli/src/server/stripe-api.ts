import { z } from "zod";
import type { HttpError } from "./lib/http";
import { answering } from "./lib/vendor-call";
import type { VendorAnswer } from "./lib/vendor-call";

export const STRIPE_API = "https://api.stripe.com";

// Pinned, since an unpinned read answers in the account's default version and a
// charge's fields change meaning across it: before basil a partial capture booked
// its uncaptured rest in amount_refunded, so captured less refunded undercounts.
const STRIPE_VERSION = "2025-03-31.basil";

export const stripeHeaders = (key: string) => ({
  Authorization: `Bearer ${key}`,
  "Stripe-Version": STRIPE_VERSION,
});

const Refusal = z.object({ error: z.object({ message: z.string() }) });

const stripeSays = (error: HttpError): string => {
  const said = Refusal.safeParse(error.answer);
  return said.success ? said.data.error.message : error.message;
};

export const answeringStripe = <T>(
  what: string,
  call: () => Promise<T> | T,
): Promise<VendorAnswer<T>> => answering("Stripe", what, call, stripeSays);

export const isTestKey = (key: string): boolean => /^[rs]k_test_/u.test(key);

/**
 * Whether `text` carries a Stripe secret key, which does anything in the account it belongs to:
 * no product or teammate ever holds one, only a restricted key granted what it needs.
 */
export const holdsStripeSecretKey = (text: string): boolean =>
  /\bsk_(?:live|test)_[0-9A-Za-z]{8,}/u.test(text);

/** Whether `text` carries any Stripe API key, secret or restricted. */
export const holdsStripeKey = (text: string): boolean =>
  /\b[rs]k_(?:live|test)_[0-9A-Za-z]{8,}/u.test(text);
