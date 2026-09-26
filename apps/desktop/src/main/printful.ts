import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { HttpError, fetchOk, getJson } from "@/main/lib/http";
import { PRINTFUL_STORE, PRINTFUL_TOKEN, getSecret } from "@/main/secrets";
import { errorMessage } from "@/shared/errors";
import { jsonValueSchema, parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";
import type { ListingVariant, PrintPlacement } from "@/shared/listing";
import { RefusalError } from "@/shared/refusal";

// Printful's v2 API, called here in main with the founder's token, which no run holds. v2 is
// still labelled beta, but Printful supports it in production, and only v2 builds an order
// straight from catalog variants, with no store products to keep in step.

const PRINTFUL_API = "https://api.printful.com";

const TIMEOUT_MS = 10_000;

const StoreSchema = z.object({ id: z.number().int(), name: z.string() });
export type PrintfulStore = z.infer<typeof StoreSchema>;

/** The founder's token and the one store it sells through. */
export interface PrintfulCredential {
  token: string;
  storeId: number;
}

export const printfulStore = (): PrintfulStore | null => {
  const saved = getSecret(PRINTFUL_STORE);
  if (!saved) {
    return null;
  }
  try {
    const parsed = StoreSchema.safeParse(parseJson(saved));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const printfulCredential = (): PrintfulCredential | null => {
  const token = getSecret(PRINTFUL_TOKEN);
  const store = printfulStore();
  return token && store ? { storeId: store.id, token } : null;
};

/** An account-wide token needs the store named; a store's own token ignores it. */
const printfulHeaders = (token: string, storeId?: number): Record<string, string> =>
  storeId === undefined
    ? { Authorization: `Bearer ${token}` }
    : { Authorization: `Bearer ${token}`, "X-PF-Store-Id": String(storeId) };

// v2 answers most errors as RFC 9457 problems, but its Catalog and Orders endpoints still in v1's shape
const Said = z.object({
  detail: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
  result: z.string().optional(),
  title: z.string().optional(),
});

/** Why Printful refused a call, in its words when it gave any. */
export const printfulSays = (error: HttpError): string => {
  const said = Said.safeParse(error.answer);
  const words = said.success
    ? (said.data.detail ?? said.data.error?.message ?? said.data.title ?? said.data.result)
    : undefined;
  return words === undefined
    ? `Printful answered ${error.status}`
    : `Printful answered ${error.status}: ${words}`;
};

export const printfulGet = (path: string, token: string, storeId?: number): Promise<JsonValue> =>
  getJson(`${PRINTFUL_API}${path}`, printfulHeaders(token, storeId), TIMEOUT_MS);

const printfulPost = async (
  path: string,
  { token, storeId }: PrintfulCredential,
  body: JsonValue,
): Promise<JsonValue> => {
  const res = await fetchOk(`${PRINTFUL_API}${path}`, {
    body: JSON.stringify(body),
    headers: { ...printfulHeaders(token, storeId), "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return jsonValueSchema.parse(await res.json());
};

/** What a listing is priced from: the variants it offers and what goes where on them. */
export interface QuoteRequest {
  credential: PrintfulCredential;
  variantIds: readonly number[];
  placements: readonly PrintPlacement[];
}

/**
 * The most Printful charges to print one and ship it anywhere in the US, tax included, and the
 * part of it that is shipping, both in cents; with each variant labelled as Printful names it.
 */
export interface PrintQuote {
  variants: ListingVariant[];
  costCents: number;
  shippingCents: number;
}

/** `refused` is the token turned away, which only a new one fixes; `failed` says why, to the agent. */
export type QuoteResult =
  | { kind: "quoted"; quote: PrintQuote }
  | { kind: "refused" }
  | { kind: "failed"; reason: string };

export type PrintQuoter = (req: QuoteRequest) => Promise<QuoteResult>;

/**
 * Where a buyer on a US-only payment link can be: the contiguous states (California, whose sales
 * tax is among the highest), and the two that cost the most to reach.
 */
const SAMPLE_ADDRESSES = [
  { country_code: "US", state_code: "CA", zip: "90012" },
  { country_code: "US", state_code: "AK", zip: "99501" },
  { country_code: "US", state_code: "HI", zip: "96813" },
] as const;

const VariantSchema = z.object({
  data: z.object({
    catalog_product_id: z.number(),
    color: z.string().nullish(),
    id: z.number(),
    name: z.string(),
    size: z.string().nullish(),
  }),
});

const CostsSchema = z.object({
  currency: z.string().nullable(),
  shipping: z.string().nullable(),
  total: z.string().nullable(),
});

const TaskSchema = z.object({
  data: z.object({
    costs: CostsSchema.nullable(),
    failure_reasons: z.array(z.string()).default([]),
    id: z.string(),
    status: z.enum(["pending", "failed", "completed"]),
  }),
});
type EstimateTask = z.infer<typeof TaskSchema>["data"];

/** How long one estimate may take to finish, polled every `pollMs`. */
const ESTIMATE_DEADLINE_MS = 60_000;

type CatalogVariant = z.infer<typeof VariantSchema>["data"];

const labelOf = ({ color, name, size }: CatalogVariant): string =>
  ([color, size].filter(Boolean).join(" / ") || name).slice(0, 100);

const centsOf = (amount: string | null, what: string): number => {
  const usd = amount === null ? Number.NaN : Number(amount);
  if (!Number.isFinite(usd) || usd < 0) {
    throw new RefusalError(`Printful's estimate gave no ${what}.`);
  }
  return Math.round(usd * 100);
};

const variantOf = async (
  id: number,
  { token, storeId }: PrintfulCredential,
): Promise<CatalogVariant> => {
  try {
    return VariantSchema.parse(await printfulGet(`/v2/catalog-variants/${id}`, token, storeId))
      .data;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new RefusalError(`Printful's catalog has no variant ${id}.`);
    }
    throw error;
  }
};

const settled = async (
  task: EstimateTask,
  { token, storeId }: PrintfulCredential,
  pollMs: number,
): Promise<EstimateTask> => {
  const deadline = Date.now() + ESTIMATE_DEADLINE_MS;
  let current = task;
  while (current.status === "pending") {
    if (Date.now() > deadline) {
      throw new RefusalError("Printful took over a minute to price it; try again.");
    }
    await sleep(pollMs);
    current = TaskSchema.parse(
      await printfulGet(
        `/v2/order-estimation-tasks?id=${encodeURIComponent(current.id)}`,
        token,
        storeId,
      ),
    ).data;
  }
  return current;
};

/** What one variant with the design costs, shipped to `recipient`, in cents. */
const estimate = async (
  variantId: number,
  placements: readonly PrintPlacement[],
  recipient: (typeof SAMPLE_ADDRESSES)[number],
  credential: PrintfulCredential,
  pollMs: number,
): Promise<{ total: number; shipping: number }> => {
  const posted = TaskSchema.parse(
    await printfulPost("/v2/order-estimation-tasks", credential, {
      order_items: [
        {
          catalog_variant_id: variantId,
          placements: placements.map(({ fileUrl, placement, technique }) => ({
            layers: [{ type: "file", url: fileUrl }],
            placement,
            technique,
          })),
          quantity: 1,
          source: "catalog",
        },
      ],
      recipient: { ...recipient },
    }),
  ).data;
  const done = await settled(posted, credential, pollMs);
  if (done.status === "failed" || done.costs === null) {
    const why = done.failure_reasons.join(" ") || "it gave no reason";
    throw new RefusalError(
      `Printful could not price variant ${variantId} to ${recipient.state_code}: ${why}`,
    );
  }
  if (done.costs.currency !== "USD") {
    throw new RefusalError(
      `Printful prices this store in ${done.costs.currency ?? "no currency"}; IdleBiz sells in USD only. The founder can change the store's currency in Printful.`,
    );
  }
  return {
    shipping: centsOf(done.costs.shipping, "shipping"),
    total: centsOf(done.costs.total, "total"),
  };
};

/**
 * Price a listing the way Printful will charge for it: an estimate for each variant with the
 * exact design, to each sample address, keeping the most any of them costs. The addresses run
 * together, the variants one after another, well inside Printful's 120 calls a minute.
 */
export const printfulQuote = async (
  { credential, placements, variantIds }: QuoteRequest,
  { pollMs = 1000 }: { pollMs?: number } = {},
): Promise<QuoteResult> => {
  try {
    const variants: CatalogVariant[] = [];
    for (const id of variantIds) {
      variants.push(await variantOf(id, credential));
    }
    const products = new Set(variants.map((v) => v.catalog_product_id));
    if (products.size > 1) {
      return {
        kind: "failed",
        reason:
          "Those variants are of different Printful products: list each product on its own, since one design and price cover every variant of a listing.",
      };
    }
    let costCents = 0;
    let shippingCents = 0;
    for (const { id } of variants) {
      const costs = await Promise.all(
        SAMPLE_ADDRESSES.map((to) => estimate(id, placements, to, credential, pollMs)),
      );
      costCents = Math.max(costCents, ...costs.map((c) => c.total));
      shippingCents = Math.max(shippingCents, ...costs.map((c) => c.shipping));
    }
    return {
      kind: "quoted",
      quote: {
        costCents,
        shippingCents,
        variants: variants.map((v) => ({ id: v.id, label: labelOf(v) })),
      },
    };
  } catch (error) {
    if (!(error instanceof HttpError)) {
      return { kind: "failed", reason: errorMessage(error) };
    }
    return error.refused ? { kind: "refused" } : { kind: "failed", reason: printfulSays(error) };
  }
};
