import { readFileSync } from "node:fs";
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

interface MetricsConfig {
  stripe?: boolean;
  plausible?: { domain: string };
  custom?: { url: string };
}

/** Absolute real-world numbers; null fields mean "no source configured". */
export interface RealSnapshot {
  users: number | null;
  revenue: number | null;
}

export function readMetricsConfig(companyId: string): MetricsConfig | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(companyDir(companyId), "metrics.json"), "utf8"),
    );
    if (!parsed || typeof parsed !== "object") return null;
    const cfg = parsed as MetricsConfig;
    if (!cfg.stripe && !cfg.plausible && !cfg.custom) return null;
    return cfg;
  } catch {
    return null;
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function stripeRevenue(): Promise<number | null> {
  const key = process.env["STRIPE_SECRET_KEY"];
  if (!key) return null;
  try {
    const data = await getJson("https://api.stripe.com/v1/charges?limit=100", {
      Authorization: `Bearer ${key}`,
    });
    if (
      !data ||
      typeof data !== "object" ||
      !("data" in data) ||
      !Array.isArray((data as { data: unknown }).data)
    )
      return null;
    let cents = 0;
    for (const c of (data as { data: unknown[] }).data) {
      if (
        c &&
        typeof c === "object" &&
        "amount" in c &&
        "paid" in c &&
        (c as { paid: unknown }).paid === true
      ) {
        const amount = (c as { amount: unknown }).amount;
        if (typeof amount === "number") cents += amount;
      }
    }
    return Math.round(cents) / 100;
  } catch {
    return null;
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
  const [stripe, visitors, custom] = await Promise.all([
    cfg.stripe ? stripeRevenue() : Promise.resolve(null),
    cfg.plausible ? plausibleVisitors(cfg.plausible.domain) : Promise.resolve(null),
    cfg.custom ? customSnapshot(cfg.custom.url) : Promise.resolve({ users: null, revenue: null }),
  ]);
  return {
    users: visitors ?? custom.users,
    revenue: stripe ?? custom.revenue,
  };
}
