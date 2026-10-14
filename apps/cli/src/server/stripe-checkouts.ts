import { z } from "zod";
import { getJson } from "./lib/http";
import { STRIPE_API, answeringStripe, stripeHeaders } from "./stripe-api";

// Stripe's checkout sessions, read account-wide in one list with their line items: a list per
// payment link would multiply the reads Stripe allows an account (on average 500 a
// transaction over 30 days), and a store that rarely sells would spend them polling.

const AddressSchema = z.object({
  city: z.string().nullish(),
  country: z.string().nullish(),
  line1: z.string().nullish(),
  line2: z.string().nullish(),
  postal_code: z.string().nullish(),
  state: z.string().nullish(),
});

// basil moved the shipping address from the session's top level to collected_information
const SessionSchema = z.object({
  amount_total: z.number().int().nullable(),
  collected_information: z
    .object({
      shipping_details: z.object({ address: AddressSchema, name: z.string() }).nullish(),
    })
    .nullish(),
  created: z.number().int(),
  currency: z.string().nullish(),
  custom_fields: z
    .array(
      z.object({ dropdown: z.object({ value: z.string().nullish() }).nullish(), key: z.string() }),
    )
    .nullish(),
  customer_details: z
    .object({ email: z.string().nullish(), phone: z.string().nullish() })
    .nullish(),
  id: z.string(),
  line_items: z
    .object({
      data: z.array(
        z.object({ description: z.string().nullish(), quantity: z.number().int().nullish() }),
      ),
    })
    .nullish(),
  livemode: z.boolean(),
  // a payment link's metadata, which Stripe copies onto each of its sessions
  metadata: z.record(z.string(), z.string()).nullish(),
  payment_intent: z.string().nullish(),
  payment_link: z.string().nullish(),
  payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
  status: z.enum(["open", "complete", "expired"]).nullish(),
});
export type CheckoutSession = z.infer<typeof SessionSchema>;

const PageSchema = z.object({ data: z.array(SessionSchema), has_more: z.boolean() });

/**
 * Every session made after the cursor, newest first; `whole` is false when there were more than
 * one read takes. `refused` is Stripe turning the key away, which only the founder can fix.
 */
export type CheckoutsRead =
  | { kind: "read"; sessions: CheckoutSession[]; whole: boolean }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; reason: string };

// a thousand checkouts between two reads is far past what a print shop run from here sees
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
/** The most checkouts one read takes. */
export const CHECKOUT_READ_LIMIT = MAX_PAGES * PAGE_SIZE;

/** Sessions created after `createdAfter` (seconds), with their line items. */
export const readCheckouts = async (key: string, createdAfter: number): Promise<CheckoutsRead> => {
  const read = await answeringStripe("checkouts", async () => {
    const sessions: CheckoutSession[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const from = after === null ? "" : `&starting_after=${after}`;
      const listed = PageSchema.parse(
        await getJson(
          `${STRIPE_API}/v1/checkout/sessions?limit=${PAGE_SIZE}&created[gt]=${createdAfter}&expand[]=data.line_items${from}`,
          stripeHeaders(key),
        ),
      );
      sessions.push(...listed.data);
      after = listed.has_more ? (listed.data.at(-1)?.id ?? null) : null;
      if (after === null) {
        return { sessions, whole: true };
      }
    }
    return { sessions, whole: false };
  });
  if (read.kind === "ok") {
    return { kind: "read", ...read.value };
  }
  return read.kind === "refused"
    ? { kind: "refused", reason: read.reason }
    : { kind: "failed", reason: read.reason };
};

const ChargesSchema = z.object({
  data: z.array(
    z.object({
      amount_refunded: z.number().int(),
      disputed: z.boolean(),
      paid: z.boolean(),
      payment_method_details: z.object({ type: z.string() }).nullish(),
    }),
  ),
});

/**
 * Whether the buyer's money is still there: `kept` when a paid charge of the payment has
 * nothing refunded and no dispute, with how it was paid (`card`, `klarna`…; null when Stripe
 * did not say), `taken` when some was refunded or disputed, `refused` when Stripe turned the key
 * away, which asking again will not change, and `unread` when Stripe could not say, which the
 * caller treats as not yet known.
 */
export type PaymentStanding =
  | { kind: "kept"; method: string | null }
  | { kind: "taken" }
  | { kind: "refused"; reason: string }
  | { kind: "unread"; reason: string };

/** Read the charges of `paymentIntent`, with the Read on Charges grant selling a print needs. */
export const readPaymentStanding = async (
  key: string,
  paymentIntent: string,
): Promise<PaymentStanding> => {
  const read = await answeringStripe("charges", async () =>
    ChargesSchema.parse(
      await getJson(
        `${STRIPE_API}/v1/charges?payment_intent=${encodeURIComponent(paymentIntent)}&limit=10`,
        stripeHeaders(key),
      ),
    ),
  );
  if (read.kind === "refused") {
    return { kind: "refused", reason: read.reason };
  }
  if (read.kind !== "ok") {
    return { kind: "unread", reason: read.reason };
  }
  const { data } = read.value;
  if (data.some((charge) => charge.amount_refunded > 0 || charge.disputed)) {
    return { kind: "taken" };
  }
  const paid = data.find((charge) => charge.paid);
  return paid === undefined
    ? { kind: "unread", reason: "Stripe lists no paid charge for it" }
    : { kind: "kept", method: paid.payment_method_details?.type ?? null };
};
