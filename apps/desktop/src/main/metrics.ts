import { z } from "zod";
import { join } from "node:path";
import { atomicWrite, readJsonFile } from "@/main/lib/fs";
import { HttpError, getJson } from "@/main/lib/http";
import { companyDir } from "@/main/paths";
import { getSecret } from "@/main/secrets";
import type { Product } from "@/shared/domain";
import { jsonValueSchema, type JsonValue } from "@/shared/json";
import { webAnalyticsVisitors } from "@/main/vercel";

// Providers live in each company's metrics.json; credentials live in secrets.json.

export const PULSE_MS = 30_000;

const MetricsConfigSchema = z.object({
  stripe: z.boolean().optional(),
  stripeAccount: z
    .object({ accountId: z.string(), livemode: z.boolean(), connectedAt: z.number() })
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
  /** A provider's credentials were rejected (e.g. Stripe token revoked). */
  authError?: boolean;
}

function metricsPath(companyId: string): string {
  return join(companyDir(companyId), "metrics.json");
}

export function readMetricsConfig(companyId: string): MetricsConfig | null {
  return readJsonFile(metricsPath(companyId), MetricsConfigSchema);
}

/** Merge a patch into metrics.json; an `undefined` field drops that provider. The file is a MetricsConfig both ways. */
export function writeMetricsConfig(companyId: string, patch: Partial<MetricsConfig>): void {
  const existing = readJsonFile(metricsPath(companyId), MetricsConfigSchema) ?? {};
  const next = MetricsConfigSchema.parse({ ...existing, ...patch });
  atomicWrite(metricsPath(companyId), JSON.stringify(next, null, 2));
}

const num = (v: JsonValue | undefined): number | null => {
  const parsed = z.number().safeParse(v);
  return parsed.success && Number.isFinite(parsed.data) ? parsed.data : null;
};

/** 401/403 from Stripe — credentials revoked or invalid. */
class StripeAuthError extends Error {}

async function stripeGet(path: string, key: string): Promise<JsonValue> {
  try {
    return await getJson(`https://api.stripe.com${path}`, { Authorization: `Bearer ${key}` });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      throw new StripeAuthError(`stripe ${err.status}`);
    }
    throw err;
  }
}

const StripeChargesSchema = z.object({
  data: z
    .array(z.object({ amount: z.number().optional(), paid: z.boolean().optional() }))
    .default([]),
});
const StripeListSchema = z.object({
  data: z.array(z.object({ id: z.string().optional() })).default([]),
  has_more: z.boolean().default(false),
});
const StripeCountSchema = z.object({ total_count: z.number() });
const PlausibleSchema = z.object({
  results: z.object({ visitors: z.object({ value: jsonValueSchema }) }),
});
const CustomSnapshotSchema = z.object({
  users: jsonValueSchema.optional(),
  revenue: jsonValueSchema.optional(),
});

async function stripeRevenue(key: string): Promise<number | null> {
  const res = StripeChargesSchema.safeParse(await stripeGet("/v1/charges?limit=100", key));
  if (!res.success) return null;
  let cents = 0;
  for (const ch of res.data.data) {
    if (ch.paid === true && ch.amount !== undefined) cents += ch.amount;
  }
  return Math.round(cents) / 100;
}

/** Exact customer count via the search API; paginate fallback if search is unavailable. */
async function stripeCustomers(key: string): Promise<number | null> {
  try {
    const counted = StripeCountSchema.safeParse(
      await stripeGet("/v1/customers/search?query=created%3E0&limit=1&include[]=total_count", key),
    );
    if (counted.success) return counted.data.total_count;
  } catch (err) {
    if (err instanceof StripeAuthError) throw err;
    /* search unsupported on this account — paginate below */
  }
  let count = 0;
  let startingAfter: string | null = null;
  for (let page = 0; page < 50; page++) {
    const qs = `limit=100${startingAfter ? `&starting_after=${startingAfter}` : ""}`;
    const parsed = StripeListSchema.safeParse(await stripeGet(`/v1/customers?${qs}`, key));
    if (!parsed.success) break;
    const rows = parsed.data.data;
    count += rows.length;
    const lastId = rows[rows.length - 1]?.id;
    if (!parsed.data.has_more || lastId === undefined) break;
    startingAfter = lastId;
  }
  return count;
}

interface StripeSnapshot {
  revenue: number | null;
  customers: number | null;
  authError: boolean;
}

async function stripeSnapshot(): Promise<StripeSnapshot> {
  const key = getSecret("STRIPE_CONNECT_TOKEN") ?? getSecret("STRIPE_SECRET_KEY");
  if (!key) return { revenue: null, customers: null, authError: false };
  try {
    const [revenue, customers] = await Promise.all([stripeRevenue(key), stripeCustomers(key)]);
    return { revenue, customers, authError: false };
  } catch (err) {
    if (err instanceof StripeAuthError) return { revenue: null, customers: null, authError: true };
    return { revenue: null, customers: null, authError: false };
  }
}

async function plausibleVisitors(domain: string): Promise<number | null> {
  const key = getSecret("PLAUSIBLE_API_KEY");
  if (!key) return null;
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
}

async function customSnapshot(
  url: string,
): Promise<{ users: number | null; revenue: number | null }> {
  try {
    const parsed = CustomSnapshotSchema.safeParse(await getJson(url, {}));
    if (parsed.success) return { users: num(parsed.data.users), revenue: num(parsed.data.revenue) };
  } catch {
    /* unreachable endpoint — report nothing */
  }
  return { users: null, revenue: null };
}

/** Visitors of every product's deploy, and their sum when any product reports. */
async function productVisitors(
  products: readonly Product[],
): Promise<{ each: Map<string, number | null>; total: number | null }> {
  const bound = products.filter((p) => p.vercel !== null);
  const counts = await Promise.all(
    bound.map((p) =>
      p.vercel ? webAnalyticsVisitors(p.vercel.projectId, p.vercel.teamId ?? undefined) : null,
    ),
  );
  const each = new Map(bound.map((p, i) => [p.id, counts[i] ?? null]));
  const known = counts.filter((n): n is number => n !== null);
  return { each, total: known.length > 0 ? known.reduce((a, b) => a + b, 0) : null };
}

export async function fetchRealMetrics(
  cfg: MetricsConfig | null,
  products: readonly Product[],
): Promise<RealSnapshot> {
  const none: StripeSnapshot = { revenue: null, customers: null, authError: false };
  const [stripe, vercel, visitors, custom] = await Promise.all([
    cfg?.stripe ? stripeSnapshot() : Promise.resolve(none),
    productVisitors(products),
    cfg?.plausible ? plausibleVisitors(cfg.plausible.domain) : Promise.resolve(null),
    cfg?.custom ? customSnapshot(cfg.custom.url) : Promise.resolve({ users: null, revenue: null }),
  ]);
  return {
    // real traffic first; paying customers as the fallback "users" signal
    users: vercel.total ?? stripe.customers ?? visitors ?? custom.users,
    revenue: stripe.revenue ?? custom.revenue,
    productUsers: vercel.each,
    authError: stripe.authError,
  };
}
