import { z } from "zod";
import type { HttpError } from "./lib/http";
import { answering } from "./lib/vendor-call";

export const STRIPE_API = "https://api.stripe.com";

const STRIPE_VERSION = "2025-03-31.basil";

export const stripeHeaders = (key: string) => ({
  Authorization: `Bearer ${key}`,
  "Stripe-Version": STRIPE_VERSION,
});

const Refusal = z.object({ error: z.object({ message: z.string() }) });

const stripeSays = (error: HttpError) => {
  const said = Refusal.safeParse(error.answer);

  return said.success ? said.data.error.message : error.message;
};

export const answeringStripe = <T>(what: string, call: () => Promise<T> | T) =>
  answering("Stripe", what, call, stripeSays);

export const isTestKey = (key: string) => /^[rs]k_test_/u.test(key);

/**
 * Whether `text` carries a Stripe secret key, which does anything in the account it belongs to:
 * no product or teammate ever holds one, only a restricted key granted what it needs.
 */
export const holdsStripeSecretKey = (text: string) =>
  /\bsk_(?:live|test)_[0-9A-Za-z]{8,}/u.test(text);

/** Whether `text` carries any Stripe API key, secret or restricted. */
export const holdsStripeKey = (text: string) => /\b[rs]k_(?:live|test)_[0-9A-Za-z]{8,}/u.test(text);
