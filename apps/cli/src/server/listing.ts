import { z } from "zod";
import { LinkStateSchema } from "./payment-link";

// A print-on-demand item on sale: what Printful prints for each paid order, and the payment
// link that takes the money. Printful names placements and techniques in lowercase snake case
// (`front`, `embroidery_chest_left`, `dtg`); holding them to that keeps what the founder signs
// plain.

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

/** A placement as it was signed off: with the digest of the file its URL served then, which an order is checked against. */
const ListedPlacementSchema = PrintPlacementSchema.extend({
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type ListedPlacement = z.infer<typeof ListedPlacementSchema>;

/** A Printful catalog variant a buyer can pick, labelled as Printful names it (colour / size). */
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
  paymentLink: z.object({
    id: z.string().min(1),
    // a listing written without one is still selling
    state: LinkStateSchema.default({ kind: "selling" }),
    url: z.url(),
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
