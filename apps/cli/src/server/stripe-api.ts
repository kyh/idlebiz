import { z } from "zod";
import type { HttpError } from "./lib/http";
import { answering } from "./lib/vendor-call";
import type { VendorAnswer } from "./lib/vendor-call";

// What every call to Stripe from main shares: the API's address, the version it is read in,
// how a key is sent, how Stripe's refusal reads, and how a failed call is answered.

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

/** Why Stripe refused, in its words when it gave any. */
const stripeSays = (error: HttpError): string => {
  const said = Refusal.safeParse(error.answer);
  return said.success ? said.data.error.message : error.message;
};

/** Run `what`, a call of Stripe's, answering its failure in Stripe's words. */
export const answeringStripe = <T>(
  what: string,
  call: () => Promise<T> | T,
): Promise<VendorAnswer<T>> => answering("Stripe", what, call, stripeSays);

/** Whether `key` is a Stripe key in test mode, whose charges nobody paid. */
export const isTestKey = (key: string): boolean => /^[rs]k_test_/u.test(key);

/**
 * Whether `text` carries a Stripe secret key, which does anything in the account it belongs to:
 * no product or teammate ever holds one, only a restricted key granted what it needs.
 */
export const holdsStripeSecretKey = (text: string): boolean =>
  /\bsk_(?:live|test)_[0-9A-Za-z]{8,}/u.test(text);
