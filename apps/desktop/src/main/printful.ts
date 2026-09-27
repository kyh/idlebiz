import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { HttpError, fetchOk } from "@/main/lib/http";
import { report } from "@/main/lib/report";
import { PRINTFUL_STORE, PRINTFUL_TOKEN, getSecret } from "@/main/secrets";
import { errorMessage } from "@/shared/errors";
import { jsonValueSchema, parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";
import { CATALOG_PAGE } from "@/shared/listing";
import type { ListingVariant, PrintPlacement } from "@/shared/listing";
import { RefusalError } from "@/shared/refusal";

// Printful's v2 API, called here in main with the founder's token, which no run holds. v2 is
// still labelled beta, but Printful supports it in production, and only v2 builds an order
// straight from catalog variants, with no store products to keep in step. Orders are in
// main/printful-orders.ts.

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

/** How often estimates are polled, and how long a rate-limited call first waits before it is tried again. */
export interface Pacing {
  pollMs: number;
  backoffMs: number;
}

// Printful allows 120 calls a minute, refilled as a leaky bucket. A listing polls its three
// sample addresses' estimates at once: every 3s that is 60 calls a minute, leaving room for the
// rest. Its X-Ratelimit-Reset header comes with no documented unit, so a 429 is waited out by
// doubling instead: the bucket refills two calls a second.
const PACING: Pacing = { backoffMs: 2000, pollMs: 3000 };
const RATE_LIMIT_RETRIES = 3;

const printfulCall = async (
  path: string,
  init: RequestInit,
  backoffMs: number,
): Promise<Response> => {
  const call = () =>
    fetchOk(`${PRINTFUL_API}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  for (let attempt = 0; attempt < RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 429) {
        throw error;
      }
      await sleep(backoffMs * 2 ** attempt);
    }
  }
  return await call();
};

const jsonOf = async (call: Promise<Response>): Promise<JsonValue> => {
  const res = await call;
  return jsonValueSchema.parse(await res.json());
};

/** GET with the founder's credential, or with a bare token before its store is known. */
export const printfulGet = (
  path: string,
  { token, storeId }: { token: string; storeId?: number },
  backoffMs = PACING.backoffMs,
): Promise<JsonValue> =>
  jsonOf(printfulCall(path, { headers: printfulHeaders(token, storeId) }, backoffMs));

/** POST `body` as JSON, or nothing when it is null. */
export const printfulPost = (
  path: string,
  { token, storeId }: PrintfulCredential,
  body: JsonValue | null,
  backoffMs = PACING.backoffMs,
): Promise<JsonValue> =>
  jsonOf(
    printfulCall(
      path,
      body === null
        ? { headers: printfulHeaders(token, storeId), method: "POST" }
        : {
            body: JSON.stringify(body),
            headers: { ...printfulHeaders(token, storeId), "Content-Type": "application/json" },
            method: "POST",
          },
      backoffMs,
    ),
  );

/** DELETE, whatever Printful answers with it: its reference names no body. */
export const printfulDelete = async (
  path: string,
  { token, storeId }: PrintfulCredential,
  backoffMs = PACING.backoffMs,
): Promise<void> => {
  const res = await printfulCall(
    path,
    { headers: printfulHeaders(token, storeId), method: "DELETE" },
    backoffMs,
  );
  await res.text();
};

/**
 * How a Printful call failed: `refused` is the token turned away, which only a new one fixes;
 * `missing` a 404; `rejected` a refusal that asking again cannot change, such as an address it
 * cannot ship to; `down` no answer to act on, so the call is tried again later.
 */
type PrintfulFault =
  | { kind: "refused" }
  | { kind: "missing"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "down"; reason: string };

const UNREADABLE_ANSWER =
  "Printful answered in a shape IdleBiz does not read, which a change on Printful's side causes; try again later";

/** How Printful answered a call: what it sent, or how the call failed. */
export type PrintfulAnswer<T> = { kind: "ok"; value: T } | PrintfulFault;

/**
 * Run a call of Printful's, answering its failure as what the caller acts on. An answer the
 * schemas refuse is a fault as well as the caller's reason: Printful's v2 is still in beta.
 */
export const answering = async <T>(
  what: string,
  call: () => Promise<T>,
): Promise<PrintfulAnswer<T>> => {
  try {
    return { kind: "ok", value: await call() };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.refused) {
        return { kind: "refused" };
      }
      if (error.status === 404) {
        return { kind: "missing", reason: printfulSays(error) };
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

/** What a failed Printful read leaves the caller: `refused` is the token turned away, which only a new one fixes; `failed` says why, to the agent. */
type PrintfulFailure = { kind: "refused" } | { kind: "failed"; reason: string };

/** Run a read of Printful's, as the agent's tools answer it: any failure but a refused token is its reason. */
const readingPrintful = async <T>(
  what: string,
  read: () => Promise<T>,
): Promise<T | PrintfulFailure> => {
  const answer = await answering(what, read);
  if (answer.kind === "ok") {
    return answer.value;
  }
  return answer.kind === "refused" ? answer : { kind: "failed", reason: answer.reason };
};

/** Printful's dollar string in whole cents, or null when it is none. */
export const usdCents = (usd: string | null | undefined): number | null => {
  const amount = usd === null || usd === undefined ? Number.NaN : Number(usd);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
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

export type QuoteResult = { kind: "quoted"; quote: PrintQuote } | PrintfulFailure;

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

const CatalogVariantSchema = z.object({
  catalog_product_id: z.number(),
  color: z.string().nullish(),
  id: z.number(),
  name: z.string(),
  size: z.string().nullish(),
});
type CatalogVariant = z.infer<typeof CatalogVariantSchema>;

const VariantSchema = z.object({ data: CatalogVariantSchema });

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

const labelOf = ({ color, name, size }: CatalogVariant): string =>
  ([color, size].filter(Boolean).join(" / ") || name).slice(0, 100);

const centsOf = (amount: string | null, what: string): number => {
  const cents = usdCents(amount);
  if (cents === null) {
    throw new RefusalError(`Printful's estimate gave no ${what}.`);
  }
  return cents;
};

const variantOf = async (
  id: number,
  credential: PrintfulCredential,
  { backoffMs }: Pacing,
): Promise<CatalogVariant> => {
  try {
    return VariantSchema.parse(
      await printfulGet(`/v2/catalog-variants/${id}`, credential, backoffMs),
    ).data;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new RefusalError(`Printful's catalog has no variant ${id}.`);
    }
    throw error;
  }
};

const settled = async (
  task: EstimateTask,
  credential: PrintfulCredential,
  { backoffMs, pollMs }: Pacing,
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
        credential,
        backoffMs,
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
  pacing: Pacing,
): Promise<{ total: number; shipping: number }> => {
  const posted = TaskSchema.parse(
    await printfulPost(
      "/v2/order-estimation-tasks",
      credential,
      {
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
      },
      pacing.backoffMs,
    ),
  ).data;
  const done = await settled(posted, credential, pacing);
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
 * exact design, to each sample address, keeping the most any of them costs.
 */
export const printfulQuote = (
  { credential, placements, variantIds }: QuoteRequest,
  pacing: Pacing = PACING,
): Promise<QuoteResult> =>
  readingPrintful("quote", async (): Promise<QuoteResult> => {
    const variants: CatalogVariant[] = [];
    for (const id of variantIds) {
      variants.push(await variantOf(id, credential, pacing));
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
        SAMPLE_ADDRESSES.map((to) => estimate(id, placements, to, credential, pacing)),
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
  });

const CatalogProductSchema = z.object({
  brand: z.string().nullish(),
  id: z.number().int(),
  is_discontinued: z.boolean().nullish(),
  model: z.string().nullish(),
  name: z.string(),
  placements: z
    .array(z.object({ placement: z.string(), technique: z.string() }))
    .nullish()
    .transform((placements) => placements ?? []),
  techniques: z
    .array(z.object({ key: z.string() }))
    .nullish()
    .transform((techniques) => techniques ?? []),
  type: z.string().nullish(),
});
export type CatalogProduct = z.infer<typeof CatalogProductSchema>;

const PagingSchema = z.object({ offset: z.number(), total: z.number() });

const ProductsSchema = z.object({ data: z.array(CatalogProductSchema), paging: PagingSchema });
const ProductSchema = z.object({ data: CatalogProductSchema });
const VariantsSchema = z.object({ data: z.array(CatalogVariantSchema) });

/** One page of the products Printful ships to the US, or one product with every variant a listing can offer. */
export type CatalogRead =
  | { kind: "products"; products: CatalogProduct[]; offset: number; total: number }
  | { kind: "product"; product: CatalogProduct; variants: ListingVariant[] }
  | PrintfulFailure;

export type CatalogQuery = { product: number } | { offset: number };

export type CatalogReader = (
  query: CatalogQuery,
  credential: PrintfulCredential,
) => Promise<CatalogRead>;

/** Printful's catalog, read with the founder's token: v2 serves it to a signed-in caller only. */
export const printfulCatalog: CatalogReader = (query, credential) =>
  readingPrintful("catalog", async (): Promise<CatalogRead> => {
    if ("offset" in query) {
      const page = ProductsSchema.parse(
        await printfulGet(
          `/v2/catalog-products?destination_country=US&limit=${CATALOG_PAGE}&offset=${query.offset}`,
          credential,
        ),
      );
      return {
        kind: "products",
        offset: page.paging.offset,
        products: page.data.filter((p) => p.is_discontinued !== true),
        total: page.paging.total,
      };
    }
    try {
      const product = ProductSchema.parse(
        await printfulGet(`/v2/catalog-products/${query.product}`, credential),
      ).data;
      const variants = VariantsSchema.parse(
        await printfulGet(`/v2/catalog-products/${query.product}/catalog-variants`, credential),
      ).data;
      return {
        kind: "product",
        product,
        variants: variants.map((v) => ({ id: v.id, label: labelOf(v) })),
      };
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return { kind: "failed", reason: `Printful's catalog has no product ${query.product}.` };
      }
      throw error;
    }
  });
