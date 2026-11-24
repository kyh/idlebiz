import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { HttpError, fetchOk } from "./lib/http";
import { answering } from "./lib/vendor-call";
import { jsonValueSchema } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";
import { CATALOG_PAGE } from "./link-record";
import type { ListingVariant, PrintPlacement } from "./link-record";
import { RefusalError } from "./refusal";

const PRINTFUL_API = "https://api.printful.com";

const TIMEOUT_MS = 10_000;

/** The founder's token and the one store it sells through (printful-token.ts keeps both). */
export interface PrintfulCredential {
  token: string;
  storeId: number;
}

const printfulHeaders = (token: string, storeId?: number) =>
  (storeId === undefined
    ? { Authorization: `Bearer ${token}` }
    : { Authorization: `Bearer ${token}`, "X-PF-Store-Id": String(storeId) }) satisfies Record<
    string,
    string
  >;

const Said = z.object({
  detail: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
  result: z.string().optional(),
  title: z.string().optional(),
});

export const printfulSays = (error: HttpError) => {
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

const PACING: Pacing = { backoffMs: 2000, pollMs: 3000 };
const RATE_LIMIT_RETRIES = 3;

const printfulCall = async (path: string, init: RequestInit, backoffMs: number) => {
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

const jsonOf = async (call: Promise<Response>) => {
  const res = await call;

  return jsonValueSchema.parse(await res.json());
};

/** GET with the founder's credential, or with a bare token before its store is known. */
export const printfulGet = (
  path: string,
  { token, storeId }: { token: string; storeId?: number },
  backoffMs = PACING.backoffMs,
) => jsonOf(printfulCall(path, { headers: printfulHeaders(token, storeId) }, backoffMs));

export const printfulPost = (
  path: string,
  { token, storeId }: PrintfulCredential,
  body: JsonValue | null,
  backoffMs = PACING.backoffMs,
) =>
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
) => {
  const res = await printfulCall(
    path,
    { headers: printfulHeaders(token, storeId), method: "DELETE" },
    backoffMs,
  );

  await res.text();
};

export const answeringPrintful = <T>(what: string, call: () => Promise<T>) =>
  answering("Printful", what, call, printfulSays);

/** What a failed Printful read leaves the caller: `refused` is the token turned away, which only a new one fixes; `failed` says why, to the agent. */
type PrintfulFailure = { kind: "refused" } | { kind: "failed"; reason: string };

const readingPrintful = async <T>(what: string, read: () => Promise<T>) => {
  const answer = await answeringPrintful(what, read);

  if (answer.kind === "ok") {
    return answer.value;
  }

  return (
    answer.kind === "refused" ? { kind: "refused" } : { kind: "failed", reason: answer.reason }
  ) satisfies T | PrintfulFailure;
};

export const usdCents = (usd: string | null | undefined) => {
  const amount = usd === null || usd === undefined ? Number.NaN : Number(usd);

  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
};

export const dollars = (cents: number) => (cents / 100).toFixed(2);

/** What a listing is priced from: the variants it offers, what goes where on them, and its price. */
export interface QuoteRequest {
  credential: PrintfulCredential;
  variantIds: readonly number[];
  placements: readonly PrintPlacement[];
  /** What the buyer pays for one before shipping, which Printful taxes some states on, as it will each order. */
  retailCents: number;
}

/**
 * The most Printful charges to print one and ship it to any sampled US address, tax and fees
 * included, and the part of it that is shipping, both in cents; with each variant labelled as
 * Printful names it.
 */
export interface PrintQuote {
  variants: ListingVariant[];
  costCents: number;
  shippingCents: number;
}

type QuoteResult = { kind: "quoted"; quote: PrintQuote } | PrintfulFailure;

export type PrintQuoter = (req: QuoteRequest) => Promise<QuoteResult>;

const SAMPLE_ADDRESSES = [
  { country_code: "US", state_code: "CA", zip: "90012" },
  { country_code: "US", state_code: "WA", zip: "98101" },
  { country_code: "US", state_code: "CO", zip: "80202" },
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

const ESTIMATE_DEADLINE_MS = 60_000;

const labelOf = ({ color, name, size }: CatalogVariant) =>
  ([color, size].filter(Boolean).join(" / ") || name).slice(0, 100);

const centsOf = (amount: string | null, what: string) => {
  const cents = usdCents(amount);

  if (cents === null) {
    throw new RefusalError(`Printful's estimate gave no ${what}.`);
  }

  return cents;
};

const variantOf = async (id: number, credential: PrintfulCredential, { backoffMs }: Pacing) => {
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
) => {
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

const estimate = async (
  variantId: number,
  { credential, placements, retailCents }: QuoteRequest,
  recipient: (typeof SAMPLE_ADDRESSES)[number],
  pacing: Pacing,
) => {
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
            retail_price: dollars(retailCents),
            source: "catalog",
          },
        ],
        recipient: { ...recipient },
        retail_costs: { currency: "USD" },
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
export const printfulQuote = (req: QuoteRequest, pacing: Pacing = PACING) =>
  readingPrintful("quote", async () => {
    const variants: CatalogVariant[] = [];

    for (const id of req.variantIds) {
      variants.push(await variantOf(id, req.credential, pacing));
    }

    const products = new Set(variants.map((v) => v.catalog_product_id));

    if (products.size > 1) {
      return {
        kind: "failed",
        reason:
          "Those variants are of different Printful products: list each product on its own, since one design and price cover every variant of a listing.",
      } satisfies QuoteResult;
    }

    let costCents = 0;
    let shippingCents = 0;

    for (const { id } of variants) {
      const costs = await Promise.all(SAMPLE_ADDRESSES.map((to) => estimate(id, req, to, pacing)));
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
    } satisfies QuoteResult;
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
  readingPrintful("catalog", async () => {
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
      } satisfies CatalogRead;
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
      } satisfies CatalogRead;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return {
          kind: "failed",
          reason: `Printful's catalog has no product ${query.product}.`,
        } satisfies CatalogRead;
      }

      throw error;
    }
  });
