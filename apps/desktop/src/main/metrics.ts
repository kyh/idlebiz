import { z } from "zod";
import { HttpError, getJson } from "@/main/lib/http";
import { STRIPE_CONNECT_TOKEN, getSecret } from "@/main/secrets";
import { readMetricsConfig } from "@/main/store/metrics-config";
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
  /** Revenue from charges tagged with the product; null for every product while no full read of the charges has come back. */
  productRevenue: ReadonlyMap<string, number | null>;
  /** What each live bet's claim has brought in, and when it was read. */
  betReadings: ReadonlyMap<string, BetRead>;
  /** How Stripe answered the company's key, and whose key it was; null when it has none. */
  stripe: { via: StripeCredential["via"]; answer: StripeAnswer } | null;
}

/** A bet's reading, null where no source can say, and when it was taken. */
interface BetRead {
  reading: number | null;
  at: number;
}

/** Stripe took the key, turned it away (401/403), or never answered, which says nothing either way. */
type StripeAnswer = "accepted" | "refused" | "unanswered";

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
        created: z.number(),
        currency: z.string().optional(),
        id: z.string().optional(),
        livemode: z.boolean().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        paid: z.boolean().optional(),
      }),
    )
    .default([]),
  has_more: z.boolean().default(false),
});

const MAX_CHARGE_PAGES = 100;

/** Cents one charge kept, and when it was made (ms). */
interface KeptCharge {
  cents: number;
  created: number;
}

export interface Revenue {
  /** Dollars kept across every captured USD charge that counts. */
  total: number;
  /** The share of it tagged `metadata[product]=<id>`; untagged money belongs to the company alone. */
  byProduct: ReadonlyMap<string, number>;
  /** The charges tagged `metadata[bet]=<id>`: what a revenue bet may claim, each with when it was made, since a measuring bet claims only those inside its window. */
  byBet: ReadonlyMap<string, readonly KeptCharge[]>;
}

/** Add a charge's kept cents, as dollars, to whatever its tag names. */
const credit = (bucket: Map<string, number>, tag: string | undefined, kept: number): void => {
  if (tag !== undefined) {
    bucket.set(tag, (bucket.get(tag) ?? 0) + kept / 100);
  }
};

/** File a charge under the bet its tag names. */
const fileCharge = (
  bucket: Map<string, KeptCharge[]>,
  tag: string | undefined,
  kept: KeptCharge,
): void => {
  if (tag === undefined) {
    return;
  }
  const filed = bucket.get(tag);
  if (filed) {
    filed.push(kept);
  } else {
    bucket.set(tag, [kept]);
  }
};

/** Dollars a bet's tagged charges kept, counting only those made by `until`. */
const keptBy = (revenue: Revenue, betId: string, until: number): number =>
  (revenue.byBet.get(betId) ?? [])
    .filter((charge) => charge.created <= until)
    .reduce((cents, charge) => cents + charge.cents, 0) / 100;

/**
 * Money kept, in dollars, from one read of every charge: what USD charges
 * captured less what they refunded, bucketed by product tag in the same pass so
 * the company's total and its products' can never disagree. An authorization,
 * or the part of one left uncaptured, is not money, and another currency's
 * minor units are not cents, so neither counts; nor does a test-mode charge
 * unless `countTest`, since nobody paid it. Null when the read is
 * incomplete — a page that cannot be parsed, or more pages than the cap — so
 * half a total never overwrites the last good one.
 */
export const sumCharges = async (
  fetchPage: (after: string | null) => Promise<JsonValue>,
  countTest: boolean,
): Promise<Revenue | null> => {
  let cents = 0;
  const byProduct = new Map<string, number>();
  const byBet = new Map<string, KeptCharge[]>();
  let after: string | null = null;
  for (let i = 0; i < MAX_CHARGE_PAGES; i += 1) {
    const page = StripeChargePageSchema.safeParse(await fetchPage(after));
    if (!page.success) {
      return null;
    }
    for (const ch of page.data.data) {
      if (
        ch.paid === true &&
        ch.captured === true &&
        ch.currency === "usd" &&
        (ch.livemode === true || countTest)
      ) {
        const kept = (ch.amount_captured ?? 0) - (ch.amount_refunded ?? 0);
        cents += kept;
        credit(byProduct, ch.metadata?.product, kept);
        fileCharge(byBet, ch.metadata?.bet, { cents: kept, created: ch.created * 1000 });
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
const stripeCharges = (
  key: string,
  since: number | null,
  countTest: boolean,
): Promise<Revenue | null> => {
  const created = since === null ? "" : `&created[gte]=${Math.floor(since / 1000)}`;
  return sumCharges(
    (after) =>
      stripeGet(`/v1/charges?limit=100${created}${after ? `&starting_after=${after}` : ""}`, key),
    countTest,
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
  return await countPages((after) =>
    stripeGet(`/v1/customers?limit=100${after ? `&starting_after=${after}` : ""}`, key),
  );
};

interface StripeSnapshot {
  /** When it was read: a kept read is as old as the pulse that took it. */
  at: number;
  /** Every charge the account has taken: the company's money and its products'. */
  charges: Revenue | null;
  /** Charges since the oldest live revenue bet opened: all a bet can claim, whatever the account's size. Null on a key that counts no money. */
  bets: Revenue | null;
  customers: number | null;
  answer: StripeAnswer;
}

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

/** Whether test-mode money counts: only in an end-to-end run of a revenue bet, never by default. */
const countsTestMoney = (): boolean => process.env.IDLEBIZ_COUNT_TEST_MONEY === "1";

/** A test-mode key sees only test-mode charges, so while those do not count, nothing it reads does. */
const countsNoMoney = (credential: StripeCredential): boolean =>
  /^[rs]k_test_/u.test(credential.key) && !countsTestMoney();

/** Whether the company reads Stripe with a key in test mode, whose charges count for nothing. */
export const stripeInTestMode = (companyId: string): boolean => {
  const credential = stripeCredential(readMetricsConfig(companyId));
  return credential !== null && countsNoMoney(credential);
};

/**
 * Why no source would read what `bet` claims, in the words the lead should act
 * on, or null when one can: the company's Stripe key for money, its product's
 * Vercel project for visitors. A window over a number nothing reads could only
 * close on no reading at all.
 */
export const measureRefusal = (bet: Bet, product: Product | null): string | null => {
  if (bet.claim.metric === "revenue") {
    const credential = stripeCredential(readMetricsConfig(bet.companyId));
    if (credential === null) {
      return 'No source reads revenue yet — ask the founder for STRIPE_SECRET_KEY, or to connect Stripe (request_integration "stripe"), then measure_bet again.';
    }
    return countsNoMoney(credential)
      ? 'Stripe is in test mode — no charge counts. Ask the founder to connect a live Stripe account (request_integration "stripe"), then measure_bet again.'
      : null;
  }
  return product?.vercel && getSecret("VERCEL_TOKEN")
    ? null
    : `No source reads users of ${product?.name ?? bet.productId} yet — ask the founder to bind Vercel to it (request_integration "vercel"), then measure_bet again.`;
};

// Every charge is re-read, since a refund can land on any old one, and
// customers are paged when search is unavailable. The numbers move in hours, so
// one read of the account is kept this long, even one that came back short or
// was refused: a null only holds the last value, and re-asking would page a
// capped account, or every charge a restricted key may read, through again
// every pulse. A new key reads at once, since the key is part of what is kept,
// and so does a change to whether test money counts; only a read Stripe never
// answered is asked again.
const STRIPE_TTL_MS = 10 * 60_000;
let stripeRead: {
  countTest: boolean;
  key: string;
  since: number | null;
  snapshot: StripeSnapshot;
} | null = null;

const settled = <T>(read: PromiseSettledResult<T | null>): T | null =>
  read.status === "fulfilled" ? read.value : null;

/** Any refusal refuses the key; any read that came back means Stripe took it. */
const answerOf = (reads: readonly PromiseSettledResult<unknown>[]): StripeAnswer => {
  if (reads.some((read) => read.status === "rejected" && read.reason instanceof StripeAuthError)) {
    return "refused";
  }
  return reads.some((read) => read.status === "fulfilled") ? "accepted" : "unanswered";
};

/**
 * Kept per key and `since` (when the oldest live revenue bet opened): a bet
 * that moves `since` reads again at once, and so does a revenue bet's window
 * (`closes`) that closed after the kept read, which its verdict waits on.
 */
const stripeSnapshot = async (
  credential: StripeCredential | null,
  since: number | null,
  closes: readonly number[],
): Promise<StripeSnapshot> => {
  const now = Date.now();
  if (credential === null) {
    return { answer: "unanswered", at: now, bets: null, charges: null, customers: null };
  }
  const { key } = credential;
  const countTest = countsTestMoney();
  const kept =
    stripeRead?.key === key && stripeRead.since === since && stripeRead.countTest === countTest
      ? stripeRead.snapshot
      : null;
  if (
    kept &&
    now - kept.at < STRIPE_TTL_MS &&
    !closes.some((until) => kept.at < until && until <= now)
  ) {
    return kept;
  }
  // Settled one by one, so a scan that times out never throws away the reads that answered.
  // A key that counts no money gives a bet no reading, not a zero: a zero would
  // close its window, or a kill, as a measured loss for dream to learn from.
  const reads = await Promise.allSettled([
    stripeCharges(key, null, countTest),
    since === null || countsNoMoney(credential) ? null : stripeCharges(key, since, countTest),
    stripeCustomers(key),
  ]);
  const [charges, bets, customers] = reads;
  const snapshot: StripeSnapshot = {
    // the bets read is a stand-in when no revenue bet is live, so it cannot say Stripe answered
    answer: answerOf([charges, customers]),
    at: now,
    bets: settled(bets),
    charges: settled(charges),
    customers: settled(customers),
  };
  if (
    reads.every((read) => read.status === "fulfilled" || read.reason instanceof StripeAuthError)
  ) {
    stripeRead = { countTest, key, since, snapshot };
  }
  return snapshot;
};

/** Visitors of every product's deploy, and their sum when any product reports. */
const productVisitors = async (
  products: readonly Product[],
): Promise<{ each: Map<string, number | null>; total: number | null }> => {
  const bound = products.flatMap(({ id, vercel }) => (vercel ? [{ id, vercel }] : []));
  const counts = await Promise.all(bound.map(({ vercel }) => webAnalyticsVisitors(vercel)));
  const each = new Map(bound.map(({ id }, i) => [id, counts[i] ?? null]));
  const known = counts.filter((n): n is number => n !== null);
  return { each, total: known.length > 0 ? known.reduce((a, b) => a + b, 0) : null };
};

/**
 * What one bet's claim has brought in, and when it was read: visitors who landed
 * on its path since it opened, as of `now`, or money carrying its tag, as of the
 * Stripe read. A measuring bet counts only up to its window's close, so a read
 * that comes long after it — past a sleep, a quit or a source that was down —
 * is still exactly the window's number.
 */
const betReading = async (
  bet: Bet,
  products: readonly Product[],
  stripe: StripeSnapshot,
  now: number,
): Promise<BetRead> => {
  const closes = bet.state.kind === "measuring" ? bet.state.until : Infinity;
  if (bet.claim.metric === "revenue") {
    return { at: stripe.at, reading: stripe.bets ? keptBy(stripe.bets, bet.id, closes) : null };
  }
  const deploy = products.find((p) => p.id === bet.productId)?.vercel;
  return {
    at: now,
    reading: deploy
      ? await webAnalyticsVisitors(deploy, {
          span: { since: bet.createdAt, until: Math.min(now, closes) },
          under: bet.claim.landingPath,
        })
      : null,
  };
};

/** When the oldest of these bets that claims money opened: no charge before it can carry a live bet's tag. */
const revenueSince = (bets: readonly Bet[]): number | null => {
  const opened = bets.filter((bet) => bet.claim.metric === "revenue").map((bet) => bet.createdAt);
  return opened.length > 0 ? Math.min(...opened) : null;
};

/** When these bets that claim money close their windows. */
const revenueCloses = (bets: readonly Bet[]): number[] =>
  bets.flatMap((bet) =>
    bet.claim.metric === "revenue" && bet.state.kind === "measuring" ? [bet.state.until] : [],
  );

/** `credential` is the company's `stripeCredential`; `bets` are the live ones: a closed bet's number is settled. */
export const fetchRealMetrics = async (
  credential: StripeCredential | null,
  products: readonly Product[],
  bets: readonly Bet[],
): Promise<RealSnapshot> => {
  const now = Date.now();
  const [stripe, vercel] = await Promise.all([
    stripeSnapshot(credential, revenueSince(bets), revenueCloses(bets)),
    productVisitors(products),
  ]);
  const { charges } = stripe;
  const readings = await Promise.all(
    bets.map(async (bet): Promise<[string, BetRead]> => [
      bet.id,
      await betReading(bet, products, stripe, now),
    ]),
  );
  return {
    betReadings: new Map(readings),
    productRevenue: new Map(
      products.map((p) => [p.id, charges ? (charges.byProduct.get(p.id) ?? 0) : null]),
    ),
    productUsers: vercel.each,
    revenue: charges?.total ?? null,
    stripe: credential ? { answer: stripe.answer, via: credential.via } : null,
    // real traffic first; paying customers as the fallback "users" signal
    users: vercel.total ?? stripe.customers,
  };
};
