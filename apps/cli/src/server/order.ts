import { createHash } from "node:crypto";
import { z } from "zod";

const OrderIdSchema = z.string().regex(/^[\w-]{1,32}$/u);

/** Printful's external id for a checkout: its hash, since a session id is longer than the 32 characters Printful keeps. */
export const orderIdOf = (sessionId: string) =>
  createHash("sha256").update(sessionId).digest("base64url").slice(0, 32);

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
  collectedCents: z.number().int().nonnegative(),
  createdAt: z.number(),
  email: z.string().nullable(),
  id: OrderIdSchema,
  livemode: z.boolean(),
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
  z.object({
    ...Paid,
    kind: z.literal("unreadable"),
    listingId: z.string().min(1),
    why: z.string(),
  }),
  z.object({
    ...Paid,
    delivery: z.string().nullable(),
    kind: z.literal("link"),
    name: z.string(),
  }),
]);

export type Order = z.infer<typeof OrderSchema>;

export type Sale = Extract<Order, { kind: "sale" }>;
