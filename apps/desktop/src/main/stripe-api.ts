import { z } from "zod";
import type { HttpError } from "@/main/lib/http";

// What every call to Stripe from main shares: the API's address, the version it is read in,
// how a key is sent, and how Stripe's refusal reads.

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
export const stripeSays = (error: HttpError): string => {
  const said = Refusal.safeParse(error.answer);
  return said.success ? said.data.error.message : error.message;
};

/** Whether `key` is a Stripe key in test mode, whose charges nobody paid. */
export const isTestKey = (key: string): boolean => /^[rs]k_test_/u.test(key);
