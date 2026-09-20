import { z } from "zod";
import path from "node:path";
import { atomicWrite, readJsonFile } from "@/main/lib/fs";
import { HttpError, getJson } from "@/main/lib/http";
import { companyDir } from "@/main/paths";
import { getSecret } from "@/main/secrets";
import type { Bet } from "@/shared/bets";
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
  /** What each live bet's claim has brought in; null where no source can say. */
  betReadings: ReadonlyMap<string, number | null>;
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
        metadata: z.record(z.string(), z.string()).optional(),
        paid: z.boolean().optional(),
      }),
    )
    .default([]),
  has_more: z.boolean().default(false),
});

const MAX_CHARGE_PAGES = 100;

export interface Revenue {
  /** Dollars kept across every charge. */
  total: number;
  /** The share of it tagged `metadata[product]=<id>`; untagged money belongs to the company alone. */
  byProduct: ReadonlyMap<string, number>;
  /** The share of it tagged `metadata[bet]=<id>`: what a revenue bet may claim. */
  byBet: ReadonlyMap<string, number>;
}

/** Add a charge's kept cents, as dollars, to whatever its tag names. */
const credit = (bucket: Map<string, number>, tag: string | undefined, kept: number): void => {
  if (tag !== undefined) {
    bucket.set(tag, (bucket.get(tag) ?? 0) + kept / 100);
  }
};

/**
 * Money kept, in dollars, from one read of every charge: paid less refunded,
 * bucketed by product tag in the same pass so the company's total and its
 * products' can never disagree. Null when the read is incomplete — a page
 * that cannot be parsed, or more pages than the cap — so half a total never
 * overwrites the last good one.
 */
export const sumCharges = async (
  fetchPage: (after: string | null) => Promise<JsonValue>,
): Promise<Revenue | null> => {
  let cents = 0;
  const byProduct = new Map<string, number>();
  const byBet = new Map<string, number>();
  let after: string | null = null;
  for (let i = 0; i < MAX_CHARGE_PAGES; i += 1) {
    const page = StripeChargePageSchema.safeParse(await fetchPage(after));
    if (!page.success) {
      return null;
    }
    for (const ch of page.data.data) {
      if (ch.paid === true) {
        const kept = (ch.amount ?? 0) - (ch.amount_refunded ?? 0);
        cents += kept;
        credit(byProduct, ch.metadata?.["product"], kept);
        credit(byBet, ch.metadata?.["bet"], kept);
      }
    }
    after = page.data.has_more ? (page.data.data.at(-1)?.id ?? null) : null;
    if (after === null) {
      return { byBet, byProduct, total: cents / 100 };
    }
  }
  return null;
};

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

// Every charge is re-read to catch refunds on old ones, which is a page per
// hundred charges; the numbers move in hours, so the read is kept this long.
const REVENUE_TTL_MS = 10 * 60_000;
let revenueRead: { at: number; key: string; revenue: Revenue } | null = null;

const stripeRevenue = async (key: string, now: number): Promise<Revenue | null> => {
  if (revenueRead && revenueRead.key === key && now - revenueRead.at < REVENUE_TTL_MS) {
    return revenueRead.revenue;
  }
  const revenue = await sumCharges((after) =>
    stripeGet(`/v1/charges?limit=100${after ? `&starting_after=${after}` : ""}`, key),
  );
  if (revenue) {
    revenueRead = { at: now, key, revenue };
  }
  return revenue;
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
  charges: Revenue | null;
  customers: number | null;
  authError: boolean;
}

const NO_STRIPE: StripeSnapshot = { authError: false, charges: null, customers: null };

const stripeSnapshot = async (): Promise<StripeSnapshot> => {
  const key = getSecret("STRIPE_CONNECT_TOKEN") ?? getSecret("STRIPE_SECRET_KEY");
  if (!key) {
    return NO_STRIPE;
  }
  try {
    const [charges, customers] = await Promise.all([
      stripeRevenue(key, Date.now()),
      stripeCustomers(key),
    ]);
    return { authError: false, charges, customers };
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
    bound.map((p) => (p.vercel ? webAnalyticsVisitors(p.vercel) : null)),
  );
  const each = new Map(bound.map((p, i) => [p.id, counts[i] ?? null]));
  const known = counts.filter((n): n is number => n !== null);
  return { each, total: known.length > 0 ? known.reduce((a, b) => a + b, 0) : null };
};

/** What one bet's claim has brought in: visitors who landed on its path since it opened, or money carrying its tag. */
const betReading = (
  bet: Bet,
  products: readonly Product[],
  charges: Revenue | null,
): Promise<number | null> => {
  if (bet.claim.metric === "revenue") {
    return Promise.resolve(charges ? (charges.byBet.get(bet.id) ?? 0) : null);
  }
  const deploy = products.find((p) => p.id === bet.productId)?.vercel;
  return deploy
    ? webAnalyticsVisitors(deploy, { since: bet.createdAt, under: bet.claim.landingPath })
    : Promise.resolve(null);
};

/** `bets` are the live ones: a closed bet's number is settled. */
export const fetchRealMetrics = async (
  cfg: MetricsConfig | null,
  products: readonly Product[],
  bets: readonly Bet[],
): Promise<RealSnapshot> => {
  const [stripe, vercel, visitors, custom] = await Promise.all([
    cfg?.stripe ? stripeSnapshot() : Promise.resolve(NO_STRIPE),
    productVisitors(products),
    cfg?.plausible ? plausibleVisitors(cfg.plausible.domain) : Promise.resolve(null),
    cfg?.custom ? customSnapshot(cfg.custom.url) : Promise.resolve({ revenue: null, users: null }),
  ]);
  const { charges } = stripe;
  const readings = await Promise.all(bets.map((bet) => betReading(bet, products, charges)));
  return {
    authError: stripe.authError,
    betReadings: new Map(bets.map((bet, i) => [bet.id, readings[i] ?? null])),
    productRevenue: new Map(
      products.map((p) => [p.id, charges ? (charges.byProduct.get(p.id) ?? 0) : null]),
    ),
    productUsers: vercel.each,
    revenue: charges?.total ?? custom.revenue,
    // real traffic first; paying customers as the fallback "users" signal
    users: vercel.total ?? stripe.customers ?? visitors ?? custom.users,
  };
};
