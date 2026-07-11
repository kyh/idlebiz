import { z } from "zod";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { companyDir } from "@/main/paths";
import { webAnalyticsVisitors } from "@/main/vercel";

// ---------------------------------------------------------------------------
// REAL business metrics only — there is no simulated economy. Numbers exist
// when a source is connected, otherwise the HUD shows a connect button.
// Sources are configured per company in metrics.json:
//
//   ~/.idlebiz/<company>/metrics.json
//   {
//     "stripe": true,                          // revenue: sum of recent Stripe charges
//                                              //   (needs STRIPE_SECRET_KEY in secrets.json)
//     "vercel": { "projectId": "prj_..." },    // users: Web Analytics visitors
//                                              //   (needs VERCEL_TOKEN in secrets.json)
//     "plausible": { "domain": "mysite.com" }, // users: 30d visitors via Plausible
//                                              //   (needs PLAUSIBLE_API_KEY in secrets.json)
//     "custom": { "url": "https://..." }       // any endpoint returning {"users":n,"revenue":n}
//   }
// ---------------------------------------------------------------------------

export const PULSE_MS = 30_000;

const MetricsConfigSchema = z.object({
  stripe: z.boolean().optional(),
  stripeAccount: z
    .object({ accountId: z.string(), livemode: z.boolean(), connectedAt: z.number() })
    .optional(),
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

/** Absolute real-world numbers; null fields mean "no source configured". */
export interface RealSnapshot {
  users: number | null;
  revenue: number | null;
  /** A provider's credentials were rejected (e.g. Stripe token revoked). */
  authError?: boolean;
}

function metricsPath(companyId: string): string {
  return join(companyDir(companyId), "metrics.json");
}

export function readMetricsConfig(companyId: string): MetricsConfig | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(metricsPath(companyId), "utf8"));
    const cfg = MetricsConfigSchema.safeParse(parsed);
    if (!cfg.success) return null;
    if (!cfg.data.stripe && !cfg.data.vercel && !cfg.data.plausible && !cfg.data.custom)
      return null;
    return cfg.data;
  } catch {
    return null;
  }
}

/** Merge a patch into metrics.json (atomic tmp+rename). */
export function writeMetricsConfig(companyId: string, patch: Partial<MetricsConfig>): void {
  const existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(metricsPath(companyId), "utf8"));
    if (parsed && typeof parsed === "object") Object.assign(existing, parsed);
  } catch {
    /* fresh file */
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete existing[k];
    else existing[k] = v;
  }
  const path = metricsPath(companyId);
  mkdirSync(companyDir(companyId), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(existing, null, 2));
  renameSync(tmp, path);
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 401/403 from Stripe — credentials revoked or invalid. */
class StripeAuthError extends Error {}

async function stripeGet(path: string, key: string): Promise<unknown> {
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401 || res.status === 403) throw new StripeAuthError(`stripe ${res.status}`);
  if (!res.ok) throw new Error(`stripe ${path} -> ${res.status}`);
  return res.json();
}

// Stripe list envelopes, parsed at the boundary (unknown fields ignored)
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
  results: z.object({ visitors: z.object({ value: z.unknown() }) }),
});
const CustomSnapshotSchema = z.object({
  users: z.unknown().optional(),
  revenue: z.unknown().optional(),
});

async function stripeRevenue(key: string): Promise<number | null> {
  const res = StripeChargesSchema.safeParse(await stripeGet("/v1/charges?limit=100", key));
  if (!res.success) return null;
  let cents = 0;
  for (const ch of res.data.data) {
    if (ch.paid === true && typeof ch.amount === "number") cents += ch.amount;
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
    if (!parsed.data.has_more || typeof lastId !== "string") break;
    startingAfter = lastId;
  }
  return count;
}

interface StripeSnapshot {
  revenue: number | null;
  customers: number | null;
  authError: boolean;
}

/** Revenue + customer count from the connected (or hand-keyed) Stripe account. */
async function stripeSnapshot(): Promise<StripeSnapshot> {
  const key = process.env["STRIPE_CONNECT_TOKEN"] ?? process.env["STRIPE_SECRET_KEY"];
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
  const key = process.env["PLAUSIBLE_API_KEY"];
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

async function customSnapshot(url: string): Promise<RealSnapshot> {
  try {
    const parsed = CustomSnapshotSchema.safeParse(await getJson(url, {}));
    if (parsed.success) return { users: num(parsed.data.users), revenue: num(parsed.data.revenue) };
  } catch {
    /* unreachable endpoint — report nothing */
  }
  return { users: null, revenue: null };
}

/** Fetch the real numbers for every configured source (nulls where unavailable). */
export async function fetchRealMetrics(cfg: MetricsConfig): Promise<RealSnapshot> {
  const none: StripeSnapshot = { revenue: null, customers: null, authError: false };
  const [stripe, vercelUsers, visitors, custom] = await Promise.all([
    cfg.stripe ? stripeSnapshot() : Promise.resolve(none),
    cfg.vercel
      ? webAnalyticsVisitors(cfg.vercel.projectId, cfg.vercel.teamId)
      : Promise.resolve(null),
    cfg.plausible ? plausibleVisitors(cfg.plausible.domain) : Promise.resolve(null),
    cfg.custom ? customSnapshot(cfg.custom.url) : Promise.resolve({ users: null, revenue: null }),
  ]);
  return {
    // real traffic first; paying customers as the fallback "users" signal
    users: vercelUsers ?? stripe.customers ?? visitors ?? custom.users,
    revenue: stripe.revenue ?? custom.revenue,
    authError: stripe.authError,
  };
}
