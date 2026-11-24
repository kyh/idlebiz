import { z } from "zod";

/** Stripe's id for a payment link, which also names its file, so it holds nothing a path reads. */
export const StripeLinkIdSchema = z.string().regex(/^plink_\w+$/u);

const LinkStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selling") }),
  z.object({
    kind: z.literal("retrying"),
    tries: z.number().int().positive(),
    why: z.string(),
  }),
  z.object({
    at: z.number(),
    by: z.enum(["idlebiz", "founder"]),
    kind: z.literal("switched-off"),
  }),
  z.object({ kind: z.literal("left-on"), why: z.string() }),
]);

/**
 * `selling` until its product retires. Then main switches it off at Stripe; while Stripe does not
 * answer (busy, failing, out of reach) it is `retrying`, `tries` sweeps so far. When Stripe
 * refuses, or never answers, it is `left-on`, `why` in the founder's card (or, for a test-mode
 * link that takes no real money, the room's line) naming it to switch off by hand, and the
 * founder's Done on that card records it `switched-off` by them.
 */
export type LinkState = z.infer<typeof LinkStateSchema>;

const LinkCoreSchema = z.object({
  id: StripeLinkIdSchema,
  livemode: z.boolean(),
  name: z.string().min(1),
  productId: z.string().min(1),
  state: LinkStateSchema,
  url: z.url(),
});

/**
 * What retirement reads of any payment link: which it is, what it sells and whether it still takes
 * money. `livemode` is false for a link made with a test-mode key, whose payments are money nobody
 * paid.
 */
export type LinkCore = z.infer<typeof LinkCoreSchema>;

/** links/<id>.json: a create_payment_link link, by Stripe's id, beside the products like a listing. */
export const ChargeLinkSchema = LinkCoreSchema.extend({
  betId: z.string().nullable(),
  cents: z.number().int().positive(),
  createdAt: z.number(),
  /** What the founder hands each buyer, as the link's metadata carries it. */
  delivery: z.string().nullable(),
});

export type ChargeLink = z.infer<typeof ChargeLinkSchema>;

/** How many products one page of Printful's catalog lists: enough to skim, few enough to read. */
export const CATALOG_PAGE = 50;

const PrintfulKeySchema = z
  .string()
  .regex(/^[a-z0-9_]{1,40}$/u, "Printful's own lowercase name, such as front or dtg");

/** Where a design goes on the item, how it is printed, and the public URL Printful fetches it from. */
export const PrintPlacementSchema = z.strictObject({
  fileUrl: z.url(),
  placement: PrintfulKeySchema,
  technique: PrintfulKeySchema,
});

export type PrintPlacement = z.infer<typeof PrintPlacementSchema>;

const ListedPlacementSchema = PrintPlacementSchema.extend({
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type ListedPlacement = z.infer<typeof ListedPlacementSchema>;

const ListingVariantSchema = z.object({
  id: z.number().int().positive(),
  label: z.string().min(1).max(100),
});

export type ListingVariant = z.infer<typeof ListingVariantSchema>;

/** listings/<id>.json, beside the products rather than in one: a retired product's orders still ship. */
export const ListingSchema = z.object({
  betId: z.string().nullable(),
  /** What Printful charged, at most, to print and ship one to the sampled US addresses when it was listed. */
  costCents: z.number().int().nonnegative(),
  createdAt: z.number(),
  id: z.string().min(1),
  /** False for a link made with a test-mode key, whose payments are money nobody paid. */
  livemode: z.boolean(),
  name: z.string().min(1),
  /** The link its buyers pay through, whose name, product and mode are the listing's own. */
  paymentLink: LinkCoreSchema.pick({ id: true, url: true }).extend({
    state: LinkStateSchema,
  }),
  placements: z.array(ListedPlacementSchema).min(1),
  /** The retail price, which the packing slip shows the buyer instead of Printful's. */
  priceCents: z.number().int().positive(),
  productId: z.string().min(1),
  /** What the buyer pays for shipping, a fixed rate on the payment link. */
  shippingCents: z.number().int().nonnegative(),
  variants: z.array(ListingVariantSchema).min(1),
});

export type Listing = z.infer<typeof ListingSchema>;

/**
 * Any payment link the company made, by the record that keeps it: a listing keeps its link inside
 * it, beside the name, product and mode the link sells under, and each order paid through it goes
 * to Printful.
 */
export type CompanyLink =
  | { kind: "charge"; link: ChargeLink }
  | { kind: "print"; link: LinkCore; listing: Listing };
