import { z } from "zod";

// A Stripe payment link the company sells through, a listing's or create_payment_link's, and
// whether it still takes money: retiring its product switches it off, so a retired product takes
// no new money. What it took before still counts and still ships.

/** Stripe's id for a payment link, which also names its file, so it holds nothing a path reads. */
export const StripeLinkIdSchema = z.string().regex(/^plink_\w+$/u);

/**
 * `selling` until its product retires. Then main switches it off at Stripe, or, when Stripe
 * would not, leaves it `left-on`, `why` in the founder's card (or, for a test-mode link that
 * takes no real money, the room's line) naming it to switch off by hand.
 */
export const LinkStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selling") }),
  z.object({ at: z.number(), kind: z.literal("switched-off") }),
  z.object({ kind: z.literal("left-on"), why: z.string() }),
]);
export type LinkState = z.infer<typeof LinkStateSchema>;

/** links/<id>.json: a create_payment_link link, by Stripe's id, beside the products like a listing. */
export const ChargeLinkSchema = z.object({
  betId: z.string().nullable(),
  cents: z.number().int().positive(),
  createdAt: z.number(),
  /** What the founder hands each buyer, as the link's metadata carries it. */
  delivery: z.string().nullable(),
  id: StripeLinkIdSchema,
  /** False for a link made with a test-mode key, whose payments are money nobody paid. */
  livemode: z.boolean(),
  name: z.string().min(1),
  productId: z.string().min(1),
  state: LinkStateSchema,
  url: z.url(),
});
export type ChargeLink = z.infer<typeof ChargeLinkSchema>;

/** Any payment link the company made, as retirement switches it off: `print` for a listing's, whose paid orders go to Printful. */
export interface CompanyLink {
  id: string;
  url: string;
  name: string;
  productId: string;
  livemode: boolean;
  print: boolean;
  state: LinkState;
}
