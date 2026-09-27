import { z } from "zod";
import { answering, printfulDelete, printfulGet, printfulPost, usdCents } from "@/main/printful";
import type { PrintfulAnswer, PrintfulCredential } from "@/main/printful";
import type { JsonValue } from "@/shared/json";
import type { PrintPlacement } from "@/shared/listing";
import type { Recipient } from "@/shared/order";

// Printful's v2 orders, placed in main with the founder's token. v2 makes every order a draft,
// which charges nothing; confirming one is what charges the founder's Printful billing method.

const OrderReadSchema = z.object({
  data: z.object({
    costs: z.object({
      calculation_status: z.enum(["done", "calculating", "failed"]),
      currency: z.string().nullish(),
      total: z.string().nullish(),
    }),
    id: z.number().int(),
    status: z.string(),
  }),
});

/** What Printful charges for an order: still being worked out, not workable, or its total in cents (null when Printful gave none it could read). */
type PrintfulCosts =
  | { kind: "calculating" }
  | { kind: "failed" }
  | { kind: "done"; currency: string | null; totalCents: number | null };

export interface PrintfulOrder {
  id: number;
  /** draft, pending, inprocess, fulfilled, failed, canceled, onhold… */
  status: string;
  costs: PrintfulCosts;
}

const dollars = (cents: number): string => (cents / 100).toFixed(2);

const orderOf = (answer: JsonValue): PrintfulOrder => {
  const { costs, id, status } = OrderReadSchema.parse(answer).data;
  return {
    costs:
      costs.calculation_status === "done"
        ? { currency: costs.currency ?? null, kind: "done", totalCents: usdCents(costs.total) }
        : { kind: costs.calculation_status },
    id,
    status,
  };
};

/** One paid order as Printful is asked to print it: the listing's variant and design, at the listing's retail prices. */
interface DraftOrder {
  externalId: string;
  recipient: Recipient;
  email: string | null;
  variantId: number;
  quantity: number;
  name: string;
  placements: readonly PrintPlacement[];
  /** What the buyer paid for one, which the packing slip shows instead of Printful's price. */
  retailCents: number;
  /** What the buyer paid for shipping. */
  retailShippingCents: number;
}

const draftBody = (draft: DraftOrder): JsonValue => {
  const { recipient: to } = draft;
  // a field the buyer left empty is left out, not sent as null
  const recipient = Object.fromEntries(
    Object.entries({
      address1: to.address1,
      address2: to.address2,
      city: to.city,
      country_code: to.countryCode,
      email: draft.email,
      name: to.name,
      phone: to.phone,
      state_code: to.stateCode,
      zip: to.zip,
    }).filter((field): field is [string, string] => field[1] !== null),
  );
  return {
    external_id: draft.externalId,
    order_items: [
      {
        catalog_variant_id: draft.variantId,
        name: draft.name,
        placements: draft.placements.map(({ fileUrl, placement, technique }) => ({
          layers: [{ type: "file", url: fileUrl }],
          placement,
          technique,
        })),
        quantity: draft.quantity,
        retail_price: dollars(draft.retailCents),
        source: "catalog",
      },
    ],
    recipient,
    retail_costs: { currency: "USD", shipping: dollars(draft.retailShippingCents) },
    shipping: "STANDARD",
  };
};

/** Printful's order calls, each answered as what the order pump acts on. */
export interface PrintfulOrders {
  /** The order made with this external id, if Printful has one: how a restart finds what it already sent. */
  lookup: (
    externalId: string,
    credential: PrintfulCredential,
  ) => Promise<PrintfulAnswer<PrintfulOrder>>;
  read: (id: number, credential: PrintfulCredential) => Promise<PrintfulAnswer<PrintfulOrder>>;
  /** A draft, which charges nothing until confirmed. */
  create: (
    draft: DraftOrder,
    credential: PrintfulCredential,
  ) => Promise<PrintfulAnswer<PrintfulOrder>>;
  /** Submit a draft for fulfilment, which charges the founder's Printful billing method. */
  confirm: (id: number, credential: PrintfulCredential) => Promise<PrintfulAnswer<PrintfulOrder>>;
  /** Delete a draft, which was never charged. */
  discard: (id: number, credential: PrintfulCredential) => Promise<PrintfulAnswer<null>>;
}

export const printfulOrders: PrintfulOrders = {
  confirm: (id, credential) =>
    answering("confirm", async () =>
      orderOf(await printfulPost(`/v2/orders/${id}/confirmation`, credential, null)),
    ),
  create: (draft, credential) =>
    answering("create", async () =>
      orderOf(await printfulPost("/v2/orders", credential, draftBody(draft))),
    ),
  discard: (id, credential) =>
    answering("discard", async () => {
      await printfulDelete(`/v2/orders/${id}`, credential);
      return null;
    }),
  lookup: (externalId, credential) =>
    answering("lookup", async () =>
      orderOf(await printfulGet(`/v2/orders/@${externalId}`, credential)),
    ),
  read: (id, credential) =>
    answering("read", async () => orderOf(await printfulGet(`/v2/orders/${id}`, credential))),
};
