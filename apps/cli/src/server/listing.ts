import { z } from "zod";
import { LinkCoreSchema, LinkStateSchema } from "./link-record";

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
