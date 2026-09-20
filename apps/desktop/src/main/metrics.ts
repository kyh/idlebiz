import { z } from "zod";
import path from "node:path";
import { atomicWrite, readJsonFile } from "@/main/lib/fs";
import { HttpError, getJson } from "@/main/lib/http";
import { companyDir } from "@/main/paths";
import { getSecret } from "@/main/secrets";
import type { Product } from "@/shared/domain";
import { jsonValueSchema } from "@/shared/json";
import type { JsonValue } from "@/shared/json";
import { webAnalyticsVisitors } from "@/main/vercel";

// Providers live in each company's metrics.json; credentials live in secrets.json.

export const PULSE_MS = 30_000;

// oxlint-disable-next-line sort-keys -- order is written to metrics.json
const MetricsConfigSchema = z.object({
  stripe: z.boolean().optional(),
  stripeAccount: z
    .object({ accountId: z.string(), connectedAt: z.number(), livemode: z.boolean() })
    .optional(),
  // a Vercel binding belongs to a product; saves from before products kept it
  // here, and boot moves it to the first product
  vercel: z
    .object({
      projectId: z.string(),
      projectName: z.string().optional(),
      teamId: z.string().optional(),
    })
    .optional(),
  plausible: z.object({ domain: z.string() }).optional(),
  custom: z.object({ url: z.string() }).optional(),
});
export type MetricsConfig = z.infer<typeof MetricsConfigSchema>;

/** Null metrics preserve the last reported value when a source is absent or unavailable. */
export interface RealSnapshot {
  users: number | null;
  revenue: number | null;
  productUsers: ReadonlyMap<string, number | null>;
  /** Revenue from charges tagged with the product; empty while Stripe is not connected. */
  productRevenue: ReadonlyMap<string, number | null>;
  /** A provider's credentials were rejected (e.g. Stripe token revoked). */
  authError?: boolean;
}

const metricsPath = (companyId: string): string => path.join(companyDir(companyId), "metrics.json");

export const readMetricsConfig = (companyId: string): MetricsConfig | null =>
  readJsonFile(metricsPath(companyId), MetricsConfigSchema);

/** Merge a patch into metrics.json; an `undefined` field drops that provider. The file is a MetricsConfig both ways. */
export const writeMetricsConfig = (companyId: string, patch: Partial<MetricsConfig>): void => {
  const existing = readJsonFile(metricsPath(companyId), MetricsConfigSchema) ?? {};
  const next = MetricsConfigSchema.parse({ ...existing, ...patch });
  atomicWrite(metricsPath(companyId), JSON.stringify(next, null, 2));
};

const num = (v: JsonValue | undefined): number | null => {
  const parsed = z.number().safeParse(v);
  return parsed.success && Number.isFinite(parsed.data) ? parsed.data : null;
};

/** 401/403 from Stripe — credentials revoked or invalid. */
class StripeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeAuthError";
  }
}

const stripeGet = async (endpoint: string, key: string): Promise<JsonValue> => {
  try {
    return await getJson(`https://api.stripe.com${endpoint}`, { Authorization: `Bearer ${key}` });
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      throw new StripeAuthError(`stripe ${error.status}`);
    }
    throw error;
  }
};

const StripeChargePageSchema = z.object({
  data: z
    .array(
      z.object({
        amount: z.number().optional(),
        amount_refunded: z.number().optional(),
        id: z.string().optional(),
        paid: z.boolean().optional(),
      }),
    )
    .default([]),
  has_more: z.boolean().default(false),
  // the search API pages by token, the list API by the last id
  next_page: z.string().nullish(),
});
type StripeChargePage = z.infer<typeof StripeChargePageSchema>;

/** Where the next page starts, or null at the end. */
type NextPage = (page: StripeChargePage) => string | null;

const MAX_CHARGE_PAGES = 100;

/**
 * Money kept, in dollars, across every page: paid charges less what was refunded.
 * Null when a page cannot be read, so a half-read total never overwrites the last good one.
 */
export const sumCharges = async (
  fetchPage: (cursor: string | null) => Promise<JsonValue>,
  cursorAfter: NextPage,
): Promise<number | null> => {
  let cents = 0;
  let cursor: string | null = null;
  for (let i = 0; i < MAX_CHARGE_PAGES; i += 1) {
    const page = StripeChargePageSchema.safeParse(await fetchPage(cursor));
    if (!page.success) {
      return null;
    }
    for (const ch of page.data.data) {
      if (ch.paid === true) {
        cents += (ch.amount ?? 0) - (ch.amount_refunded ?? 0);
      }
    }
    cursor = page.data.has_more ? cursorAfter(page.data) : null;
    if (cursor === null) {
      break;
    }
  }
  return Math.round(cents) / 100;
};

export const afterLastId: NextPage = (page) => page.data.at(-1)?.id ?? null;
export const byPageToken: NextPage = (page) => page.next_page ?? null;

const StripeListSchema = z.object({
  data: z.array(z.object({ id: z.string().optional() })).default([]),
  has_more: z.boolean().default(false),
});
const StripeCountSchema = z.object({ total_count: z.number() });
const PlausibleSchema = z.object({
  results: z.object({ visitors: z.object({ value: jsonValueSchema }) }),
});
const CustomSnapshotSchema = z.object({
  revenue: jsonValueSchema.optional(),
  users: jsonValueSchema.optional(),
});

const stripeRevenue = (key: string): Promise<number | null> =>
  sumCharges(
    (after) => stripeGet(`/v1/charges?limit=100${after ? `&starting_after=${after}` : ""}`, key),
    afterLastId,
  );

/**
 * What one product earned: charges the team tagged `metadata[product]=<id>`.
 * Untagged revenue still counts for the company, but no product and no bet can claim it.
 */
const stripeProductRevenue = (key: string, productId: string): Promise<number | null> => {
  const query = encodeURIComponent(`metadata['product']:'${productId}' AND status:'succeeded'`);
  return sumCharges(
    (page) =>
      stripeGet(
        `/v1/charges/search?query=${query}&limit=100${page ? `&page=${encodeURIComponent(page)}` : ""}`,
        key,
      ),
    byPageToken,
  );
};

/** Exact customer count via the search API; paginate fallback if search is unavailable. */
const stripeCustomers = async (key: string): Promise<number | null> => {
  try {
    const counted = StripeCountSchema.safeParse(
      await stripeGet("/v1/customers/search?query=created%3E0&limit=1&include[]=total_count", key),
    );
    if (counted.success) {
      return counted.data.total_count;
    }
  } catch (error) {
    if (error instanceof StripeAuthError) {
      throw error;
    }
    /* search unsupported on this account — paginate below */
  }
  let count = 0;
  let startingAfter: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const qs = `limit=100${startingAfter ? `&starting_after=${startingAfter}` : ""}`;
    const parsed = StripeListSchema.safeParse(await stripeGet(`/v1/customers?${qs}`, key));
    if (!parsed.success) {
      break;
    }
    const rows = parsed.data.data;
    count += rows.length;
    const lastId = rows.at(-1)?.id;
    if (!parsed.data.has_more || lastId === undefined) {
      break;
    }
    startingAfter = lastId;
  }
  return count;
};

interface StripeSnapshot {
  revenue: number | null;
  customers: number | null;
  perProduct: Map<string, number | null>;
  authError: boolean;
}

const NO_STRIPE: StripeSnapshot = {
  authError: false,
  customers: null,
  perProduct: new Map(),
  revenue: null,
};

const stripeSnapshot = async (products: readonly Product[]): Promise<StripeSnapshot> => {
  const key = getSecret("STRIPE_CONNECT_TOKEN") ?? getSecret("STRIPE_SECRET_KEY");
  if (!key) {
    return NO_STRIPE;
  }
  try {
    const [revenue, customers, each] = await Promise.all([
      stripeRevenue(key),
      stripeCustomers(key),
      Promise.all(products.map((p) => stripeProductRevenue(key, p.id))),
    ]);
    const perProduct = new Map(products.map((p, i) => [p.id, each[i] ?? null]));
    return { authError: false, customers, perProduct, revenue };
  } catch (error) {
    return error instanceof StripeAuthError ? { ...NO_STRIPE, authError: true } : NO_STRIPE;
  }
};

const plausibleVisitors = async (domain: string): Promise<number | null> => {
  const key = getSecret("PLAUSIBLE_API_KEY");
  if (!key) {
    return null;
  }
  try {
    const data = await getJson(
      `https://plausible.io/api/v1/stats/aggregate?site_id=${encodeURIComponent(domain)}&period=30d&metrics=visitors`,
      { Authorization: `Bearer ${key}` },
    );
    const parsed = PlausibleSchema.safeParse(data);
    return parsed.success ? num(parsed.data.results.visitors.value) : null;
  } catch {
    return null;
  }
};

const customSnapshot = async (
  url: string,
): Promise<{ users: number | null; revenue: number | null }> => {
  try {
    const parsed = CustomSnapshotSchema.safeParse(await getJson(url, {}));
    if (parsed.success) {
      return { revenue: num(parsed.data.revenue), users: num(parsed.data.users) };
    }
  } catch {
    /* unreachable endpoint — report nothing */
  }
  return { revenue: null, users: null };
};

/** Visitors of every product's deploy, and their sum when any product reports. */
const productVisitors = async (
  products: readonly Product[],
): Promise<{ each: Map<string, number | null>; total: number | null }> => {
  const bound = products.filter((p) => p.vercel !== null);
  const counts = await Promise.all(
    bound.map((p) =>
      p.vercel ? webAnalyticsVisitors(p.vercel.projectId, p.vercel.teamId ?? undefined) : null,
    ),
  );
  const each = new Map(bound.map((p, i) => [p.id, counts[i] ?? null]));
  const known = counts.filter((n): n is number => n !== null);
  return { each, total: known.length > 0 ? known.reduce((a, b) => a + b, 0) : null };
};

export const fetchRealMetrics = async (
  cfg: MetricsConfig | null,
  products: readonly Product[],
): Promise<RealSnapshot> => {
  const [stripe, vercel, visitors, custom] = await Promise.all([
    cfg?.stripe ? stripeSnapshot(products) : Promise.resolve(NO_STRIPE),
    productVisitors(products),
    cfg?.plausible ? plausibleVisitors(cfg.plausible.domain) : Promise.resolve(null),
    cfg?.custom ? customSnapshot(cfg.custom.url) : Promise.resolve({ revenue: null, users: null }),
  ]);
  return {
    authError: stripe.authError,
    productRevenue: stripe.perProduct,
    productUsers: vercel.each,
    revenue: stripe.revenue ?? custom.revenue,
    // real traffic first; paying customers as the fallback "users" signal
    users: vercel.total ?? stripe.customers ?? visitors ?? custom.users,
  };
};
