import { z } from "zod";
import { HttpError, getJson } from "@/main/lib/http";
import { STRIPE_CONNECT_TOKEN, getSecret } from "@/main/secrets";
import type { MetricsConfig } from "@/main/store/metrics-config";
import type { Bet } from "@/shared/bets";
import type { Product } from "@/shared/domain";
import type { JsonValue } from "@/shared/json";
import { webAnalyticsVisitors } from "@/main/vercel";

// Credentials live in secrets.json; the Stripe account a company connected, in its metrics.json (main/store/metrics-config.ts).

export const PULSE_MS = 30_000;

/** Null metrics preserve the last reported value when a source is absent or unavailable. */
export interface RealSnapshot {
  users: number | null;
  revenue: number | null;
  productUsers: ReadonlyMap<string, number | null>;
  /** Revenue from charges tagged with the product; empty while Stripe is not connected. */
  productRevenue: ReadonlyMap<string, number | null>;
  /** What each live bet's claim has brought in; null where no source can say. */
  betReadings: ReadonlyMap<string, number | null>;
  /** Stripe refused the Connect token (401/403): the account revoked access. A refused own key only leaves revenue unread. */
  connectRevoked: boolean;
}

/** 401/403 from Stripe — credentials revoked or invalid. */
class StripeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeAuthError";
  }
}

// Pinned, since an unpinned read answers in the account's default version and a
// charge's fields change meaning across it: before basil a partial capture booked
// its uncaptured rest in amount_refunded, so captured less refunded undercounts.
const STRIPE_VERSION = "2025-03-31.basil";

const stripeGet = async (endpoint: string, key: string): Promise<JsonValue> => {
  try {
    return await getJson(`https://api.stripe.com${endpoint}`, {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": STRIPE_VERSION,
    });
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
        amount_captured: z.number().optional(),
        amount_refunded: z.number().optional(),
        captured: z.boolean().optional(),
        currency: z.string().optional(),
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
  /** Dollars kept across every captured USD charge. */
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
 * Money kept, in dollars, from one read of every charge: what USD charges
 * captured less what they refunded, bucketed by product tag in the same pass so
 * the company's total and its products' can never disagree. An authorization,
 * or the part of one left uncaptured, is not money, and another currency's
 * minor units are not cents, so neither counts. Null when the read is
 * incomplete — a page that cannot be parsed, or more pages than the cap — so
 * half a total never overwrites the last good one.
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
      if (ch.paid === true && ch.captured === true && ch.currency === "usd") {
        const kept = (ch.amount_captured ?? 0) - (ch.amount_refunded ?? 0);
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

const MAX_CUSTOMER_PAGES = 50;

/** Rows across a list, or null when the read is incomplete, by the same rule as `sumCharges`. */
export const countPages = async (
  fetchPage: (after: string | null) => Promise<JsonValue>,
): Promise<number | null> => {
  let count = 0;
  let after: string | null = null;
  for (let i = 0; i < MAX_CUSTOMER_PAGES; i += 1) {
    const page = StripeListSchema.safeParse(await fetchPage(after));
    if (!page.success) {
      return null;
    }
    count += page.data.data.length;
    after = page.data.has_more ? (page.data.data.at(-1)?.id ?? null) : null;
    if (after === null) {
      return count;
    }
  }
  return null;
};

/** Every charge on the account, or only those created since `since` (ms). */
const stripeCharges = (key: string, since: number | null): Promise<Revenue | null> => {
  const created = since === null ? "" : `&created[gte]=${Math.floor(since / 1000)}`;
  return sumCharges((after) =>
    stripeGet(`/v1/charges?limit=100${created}${after ? `&starting_after=${after}` : ""}`, key),
  );
};

/** Exact customer count via the search API; paginate fallback if search is unavailable. */
const stripeCustomers = async (key: string): Promise<number | null> => {
  try {
    const counted = StripeCountSchema.safeParse(
      await stripeGet("/v1/customers/search?query=created%3E0&limit=1&expand[]=total_count", key),
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
  return countPages((after) =>
    stripeGet(`/v1/customers?limit=100${after ? `&starting_after=${after}` : ""}`, key),
  );
};

interface StripeSnapshot {
  /** Every charge the account has taken: the company's money and its products'. */
  charges: Revenue | null;
  /** Charges since the oldest live revenue bet opened: all a bet can claim, whatever the account's size. */
  bets: Revenue | null;
  customers: number | null;
  /** Stripe answered 401/403 to this key. */
  refused: boolean;
}

const NO_STRIPE: StripeSnapshot = { bets: null, charges: null, customers: null, refused: false };

/** The key a company reads Stripe with, and whose it is: only a refused Connect token means the connection was revoked. */
export interface StripeCredential {
  via: "connect" | "own";
  key: string;
}

/**
 * secrets.json is shared by every company and a Connect token outlives the
 * company that connected it, so only that company reads it; the founder's own
 * key is the one employees charge with, so it always counts. A key left blank
 * in the file is no key.
 */
export const stripeCredential = (cfg: MetricsConfig | null): StripeCredential | null => {
  const token = cfg?.stripeAccount ? getSecret(STRIPE_CONNECT_TOKEN) : null;
  if (token) {
    return { key: token, via: "connect" };
  }
  const own = getSecret("STRIPE_SECRET_KEY");
  return own ? { key: own, via: "own" } : null;
};

// Every charge is re-read, since a refund can land on any old one, and
// customers are paged when search is unavailable. The numbers move in hours, so
// one read of the account is kept this long, even one that came back short: a
// null only holds the last value, and re-asking would page a capped account
// through again every pulse.
const STRIPE_TTL_MS = 10 * 60_000;
let stripeRead: { at: number; key: string; since: number | null; snapshot: StripeSnapshot } | null =
  null;

const settled = <T>(read: PromiseSettledResult<T | null>): T | null =>
  read.status === "fulfilled" ? read.value : null;

/** Kept per key and `since` (when the oldest live revenue bet opened): a bet that moves `since` reads again at once. */
const stripeSnapshot = async (
  credential: StripeCredential | null,
  since: number | null,
): Promise<StripeSnapshot> => {
  if (credential === null) {
    return NO_STRIPE;
  }
  const { key } = credential;
  const now = Date.now();
  if (
    stripeRead?.key === key &&
    stripeRead.since === since &&
    now - stripeRead.at < STRIPE_TTL_MS
  ) {
    return stripeRead.snapshot;
  }
  // Settled one by one, so a scan that times out never throws away the reads that answered.
  const reads = await Promise.allSettled([
    stripeCharges(key, null),
    since === null ? null : stripeCharges(key, since),
    stripeCustomers(key),
  ]);
  const [charges, bets, customers] = reads;
  const snapshot: StripeSnapshot = {
    bets: settled(bets),
    charges: settled(charges),
    customers: settled(customers),
    refused: reads.some(
      (read) => read.status === "rejected" && read.reason instanceof StripeAuthError,
    ),
  };
  if (reads.every((read) => read.status === "fulfilled")) {
    stripeRead = { at: now, key, since, snapshot };
  }
  return snapshot;
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
  betCharges: Revenue | null,
): Promise<number | null> => {
  if (bet.claim.metric === "revenue") {
    return Promise.resolve(betCharges ? (betCharges.byBet.get(bet.id) ?? 0) : null);
  }
  const deploy = products.find((p) => p.id === bet.productId)?.vercel;
  return deploy
    ? webAnalyticsVisitors(deploy, { since: bet.createdAt, under: bet.claim.landingPath })
    : Promise.resolve(null);
};

/** When the oldest of these bets that claims money opened: no charge before it can carry a live bet's tag. */
const revenueSince = (bets: readonly Bet[]): number | null => {
  const opened = bets.filter((bet) => bet.claim.metric === "revenue").map((bet) => bet.createdAt);
  return opened.length > 0 ? Math.min(...opened) : null;
};

/** `credential` is the company's `stripeCredential`; `bets` are the live ones: a closed bet's number is settled. */
export const fetchRealMetrics = async (
  credential: StripeCredential | null,
  products: readonly Product[],
  bets: readonly Bet[],
): Promise<RealSnapshot> => {
  const [stripe, vercel] = await Promise.all([
    stripeSnapshot(credential, revenueSince(bets)),
    productVisitors(products),
  ]);
  const { charges } = stripe;
  const readings = await Promise.all(bets.map((bet) => betReading(bet, products, stripe.bets)));
  return {
    betReadings: new Map(bets.map((bet, i) => [bet.id, readings[i] ?? null])),
    connectRevoked: stripe.refused && credential?.via === "connect",
    productRevenue: new Map(
      products.map((p) => [p.id, charges ? (charges.byProduct.get(p.id) ?? 0) : null]),
    ),
    productUsers: vercel.each,
    revenue: charges?.total ?? null,
    // real traffic first; paying customers as the fallback "users" signal
    users: vercel.total ?? stripe.customers,
  };
};
