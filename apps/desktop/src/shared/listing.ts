import { z } from "zod";

// A print-on-demand item on sale: what Printful prints for each paid order, and the payment
// link that takes the money. Printful names placements and techniques in lowercase snake case
// (`front`, `embroidery_chest_left`, `dtg`); holding them to that keeps what the founder signs
// plain.

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

/** A Printful catalog variant a buyer can pick, labelled as Printful names it (colour / size). */
const ListingVariantSchema = z.object({
  id: z.number().int().positive(),
  label: z.string().min(1).max(100),
});
export type ListingVariant = z.infer<typeof ListingVariantSchema>;

/** products/<product>/listings/<id>.json; the product is the folder it sits in. */
export const ListingSchema = z.object({
  betId: z.string().nullable(),
  /** What Printful charged, at most, to print and ship one to the sampled US addresses when it was listed. */
  costCents: z.number().int().nonnegative(),
  createdAt: z.number(),
  id: z.string().min(1),
  name: z.string().min(1),
  paymentLink: z.object({ id: z.string().min(1), url: z.url() }),
  placements: z.array(PrintPlacementSchema).min(1),
  /** The retail price, which the packing slip shows the buyer instead of Printful's. */
  priceCents: z.number().int().positive(),
  productId: z.string().min(1),
  /** What the buyer pays for shipping, a fixed rate on the payment link. */
  shippingCents: z.number().int().nonnegative(),
  variants: z.array(ListingVariantSchema).min(1),
});
export type Listing = z.infer<typeof ListingSchema>;
