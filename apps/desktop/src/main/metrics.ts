import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { companyDir } from "@/main/paths";
import type { Company } from "@/shared/domain";

// ---------------------------------------------------------------------------
// Business metrics as a swappable provider. By default the numbers are
// simulated (light idle-game economy). Drop a metrics.json into the company
// package and the REAL providers take over — the HUD then shows your actual
// business:
//
//   ~/.idlebiz/<company>/metrics.json
//   {
//     "stripe": true,                          // revenue: sum of recent Stripe charges
//                                              //   (needs STRIPE_SECRET_KEY in secrets.json)
//     "plausible": { "domain": "mysite.com" }, // users: 30d visitors via Plausible
//                                              //   (needs PLAUSIBLE_API_KEY in secrets.json)
//     "custom": { "url": "https://..." }       // any endpoint returning {"users":n,"revenue":n}
//   }
// ---------------------------------------------------------------------------

export interface BusinessPulse {
  usersDelta: number;
  cashDelta: number;
}

export interface MetricsProvider {
  /** Periodic accrual while the business is running (called every pulse tick). */
  pulse(company: Company): BusinessPulse;
  /** Boost when the team ships a unit of work. */
  onShip(company: Company): BusinessPulse;
}

export const PULSE_MS = 30_000;

export const simulatedMetrics: MetricsProvider = {
  pulse(company) {
    if (company.users <= 0) return { usersDelta: 0, cashDelta: 0 };
    // existing users trickle in revenue and a little word-of-mouth growth
    const cashDelta = Math.round(company.users * 0.02 * 100) / 100;
    const usersDelta = Math.random() < 0.5 ? Math.ceil(company.users * 0.005) : 0;
    return { usersDelta, cashDelta };
  },
  onShip(company) {
    return {
      usersDelta: 8 + Math.floor(Math.random() * 24) + Math.floor(company.users * 0.04),
      cashDelta: 40 + Math.round(company.users * 0.08),
    };
  },
};

// ---- real-world providers ----------------------------------------------------

export interface MetricsConfig {
  stripe?: boolean;
  stripeAccount?: { accountId: string; livemode: boolean; connectedAt: number };
  plausible?: { domain: string };
  custom?: { url: string };
}

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
    if (!parsed || typeof parsed !== "object") return null;
    const cfg = parsed as MetricsConfig;
    if (!cfg.stripe && !cfg.plausible && !cfg.custom) return null;
    return cfg;
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

function listData(data: unknown): unknown[] {
  if (data && typeof data === "object" && "data" in data) {
    const inner = (data as { data: unknown }).data;
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

async function stripeRevenue(key: string): Promise<number | null> {
  const data = await stripeGet("/v1/charges?limit=100", key);
  let cents = 0;
  for (const ch of listData(data)) {
    if (
      ch &&
      typeof ch === "object" &&
      "amount" in ch &&
      "paid" in ch &&
      (ch as { paid: unknown }).paid === true
    ) {
      const amount = (ch as { amount: unknown }).amount;
      if (typeof amount === "number") cents += amount;
    }
  }
  return Math.round(cents) / 100;
}

/** Exact customer count via the search API; paginate fallback if search is unavailable. */
async function stripeCustomers(key: string): Promise<number | null> {
  try {
    const data = await stripeGet(
      "/v1/customers/search?query=created%3E0&limit=1&include[]=total_count",
      key,
    );
    if (data && typeof data === "object" && "total_count" in data) {
      const t = (data as { total_count: unknown }).total_count;
      if (typeof t === "number") return t;
    }
  } catch (err) {
    if (err instanceof StripeAuthError) throw err;
    /* search unsupported on this account — paginate below */
  }
  let count = 0;
  let startingAfter: string | null = null;
  for (let page = 0; page < 50; page++) {
    const qs = `limit=100${startingAfter ? `&starting_after=${startingAfter}` : ""}`;
    const data = await stripeGet(`/v1/customers?${qs}`, key);
    const rows = listData(data);
    count += rows.length;
    const last: unknown = rows[rows.length - 1];
    const hasMore =
      data && typeof data === "object" && "has_more" in data
        ? (data as { has_more: unknown }).has_more === true
        : false;
    if (!hasMore || !last || typeof last !== "object" || !("id" in last)) break;
    const lastId = (last as { id: unknown }).id;
    if (typeof lastId !== "string") break;
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
    if (data && typeof data === "object" && "results" in data) {
      const results = (data as { results: unknown }).results;
      if (results && typeof results === "object" && "visitors" in results) {
        const v = (results as { visitors: unknown }).visitors;
        if (v && typeof v === "object" && "value" in v) return num((v as { value: unknown }).value);
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function customSnapshot(url: string): Promise<RealSnapshot> {
  try {
    const data = await getJson(url, {});
    if (data && typeof data === "object") {
      const d = data as { users?: unknown; revenue?: unknown };
      return { users: num(d.users), revenue: num(d.revenue) };
    }
  } catch {
    /* unreachable endpoint — report nothing */
  }
  return { users: null, revenue: null };
}

/** Fetch the real numbers for every configured source (nulls where unavailable). */
export async function fetchRealMetrics(cfg: MetricsConfig): Promise<RealSnapshot> {
  const none: StripeSnapshot = { revenue: null, customers: null, authError: false };
  const [stripe, visitors, custom] = await Promise.all([
    cfg.stripe ? stripeSnapshot() : Promise.resolve(none),
    cfg.plausible ? plausibleVisitors(cfg.plausible.domain) : Promise.resolve(null),
    cfg.custom ? customSnapshot(cfg.custom.url) : Promise.resolve({ users: null, revenue: null }),
  ]);
  return {
    // paying customers are the strongest "users" signal when Stripe is connected
    users: stripe.customers ?? visitors ?? custom.users,
    revenue: stripe.revenue ?? custom.revenue,
    authError: stripe.authError,
  };
}
