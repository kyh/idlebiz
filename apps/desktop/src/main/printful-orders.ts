import { z } from "zod";
import { HttpError } from "@/main/lib/http";
import { report } from "@/main/lib/report";
import { UNREADABLE_ANSWER, printfulGet, printfulPost, printfulSays } from "@/main/printful";
import type { PrintfulCredential } from "@/main/printful";
import { errorMessage } from "@/shared/errors";
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

/**
 * How Printful answered: `missing` is a 404; `refused` its turning the token away, which only a
 * new one fixes; `rejected` a refusal that asking again cannot change, such as an address it
 * cannot ship to; `down` no answer to act on, so the call is tried again later.
 */
type PrintfulAnswer<T> =
  | { kind: "ok"; value: T }
  | { kind: "missing" }
  | { kind: "refused" }
  | { kind: "rejected"; reason: string }
  | { kind: "down"; reason: string };

const centsOf = (usd: string | null | undefined): number | null => {
  const amount = usd === null || usd === undefined ? Number.NaN : Number(usd);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
};

const dollars = (cents: number): string => (cents / 100).toFixed(2);

const orderOf = (answer: JsonValue): PrintfulOrder => {
  const { costs, id, status } = OrderReadSchema.parse(answer).data;
  return {
    costs:
      costs.calculation_status === "done"
        ? { currency: costs.currency ?? null, kind: "done", totalCents: centsOf(costs.total) }
        : { kind: costs.calculation_status },
    id,
    status,
  };
};

const answering = async (
  what: string,
  call: () => Promise<JsonValue>,
): Promise<PrintfulAnswer<PrintfulOrder>> => {
  try {
    return { kind: "ok", value: orderOf(await call()) };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.refused) {
        return { kind: "refused" };
      }
      if (error.status === 404) {
        return { kind: "missing" };
      }
      // a 429 still there after the call's own retries is Printful being busy, not a refusal
      const permanent = error.status >= 400 && error.status < 500 && error.status !== 429;
      return { kind: permanent ? "rejected" : "down", reason: printfulSays(error) };
    }
    if (error instanceof z.ZodError) {
      report(`printful ${what}`, error);
      return { kind: "down", reason: UNREADABLE_ANSWER };
    }
    return { kind: "down", reason: errorMessage(error) };
  }
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
}

export const printfulOrders: PrintfulOrders = {
  confirm: (id, credential) =>
    answering("confirm", () => printfulPost(`/v2/orders/${id}/confirmation`, credential, null)),
  create: (draft, credential) =>
    answering("create", () => printfulPost("/v2/orders", credential, draftBody(draft))),
  lookup: (externalId, { storeId, token }) =>
    answering("lookup", () => printfulGet(`/v2/orders/@${externalId}`, token, storeId)),
  read: (id, { storeId, token }) =>
    answering("read", () => printfulGet(`/v2/orders/${id}`, token, storeId)),
};
