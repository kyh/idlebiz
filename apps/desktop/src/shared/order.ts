import { z } from "zod";

// A paid checkout on one of the company's payment links, and, for a listing's, what became of it
// at Printful. Main writes one file per order; runs may read them, so support can answer a buyer.

/** Printful's `external_id`: at most 32 of [A-Za-z0-9_-], unique per store, which makes creating an order idempotent. */
const OrderIdSchema = z.string().regex(/^[\w-]{1,32}$/u);

/** Where Printful ships it, as the buyer entered it on Stripe's page. */
const RecipientSchema = z.object({
  address1: z.string(),
  address2: z.string().nullable(),
  city: z.string(),
  countryCode: z.string(),
  name: z.string(),
  phone: z.string().nullable(),
  stateCode: z.string(),
  zip: z.string(),
});
export type Recipient = z.infer<typeof RecipientSchema>;

/**
 * Where an order stands between IdleBiz and Printful. `received` is on disk before Printful is
 * asked anything, so a restart finds it and looks it up by its external id rather than make it
 * twice; `tries` counts failed sends. `pricing` is a draft whose costs are being worked out,
 * `checks` the reads so far. `held` waits on the founder, who has a card saying `why`.
 * `test` was paid in test mode: priced, then its draft deleted, since nobody paid for it.
 */
const OrderStageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("received"), tries: z.number().int().nonnegative() }),
  z.object({
    checks: z.number().int().nonnegative(),
    kind: z.literal("pricing"),
    printfulId: z.number().int(),
  }),
  z.object({ kind: z.literal("confirmed"), printfulId: z.number().int() }),
  z.object({ kind: z.literal("held"), printfulId: z.number().int().nullable(), why: z.string() }),
  z.object({ kind: z.literal("test"), printfulId: z.number().int() }),
]);

const Paid = {
  /** What Stripe collected, in cents: the price and the shipping the buyer paid. */
  collectedCents: z.number().int().nonnegative(),
  /** When the buyer opened the checkout (ms). */
  createdAt: z.number(),
  email: z.string().nullable(),
  id: OrderIdSchema,
  /** False for a checkout in test mode, which nobody paid. */
  livemode: z.boolean(),
  /** What a refund in Stripe is made against. */
  paymentIntent: z.string().nullable(),
  productId: z.string().min(1),
  sessionId: z.string().min(1),
};

/** orders/<id>.json, beside the products rather than in one: a retired product's orders still ship. */
export const OrderSchema = z.discriminatedUnion("kind", [
  z.object({
    ...Paid,
    /** What Printful charges for it, in cents, once it has priced the draft. */
    costCents: z.number().int().nonnegative().nullable(),
    kind: z.literal("sale"),
    listingId: z.string().min(1),
    /** Printful's own status (draft, pending, fulfilled, failed…) as last read; `deleted` once Printful no longer has it. */
    printfulStatus: z.string().nullable(),
    quantity: z.number().int().positive(),
    recipient: RecipientSchema,
    stage: OrderStageSchema,
    variant: z.object({ id: z.number().int().positive(), label: z.string() }),
  }),
  /** Paid, but not an order IdleBiz can send, such as one with no shipping address: the founder's, by hand. */
  z.object({
    ...Paid,
    kind: z.literal("unreadable"),
    listingId: z.string().min(1),
    why: z.string(),
  }),
  /**
   * Paid on a create_payment_link link, where nothing ships on its own: `name` is what it sold,
   * `delivery` what the team said the founder hands each buyer, null when it said nothing.
   */
  z.object({
    ...Paid,
    delivery: z.string().nullable(),
    kind: z.literal("link"),
    name: z.string(),
  }),
]);
export type Order = z.infer<typeof OrderSchema>;
export type Sale = Extract<Order, { kind: "sale" }>;
