import { z } from "zod";
import { HttpError, getJson } from "./lib/http";
import { STRIPE_SECRET_KEY, VERCEL_TOKEN } from "./vault/names";
import { getSecret } from "./vault/vault";
import { STRIPE_API, isTestKey, stripeHeaders } from "./stripe-api";
import type { Bet } from "@repo/domain/bets";
import type { Product } from "@repo/domain/domain";
import type { JsonValue } from "@repo/domain/json";
import { webAnalyticsVisitors } from "./vercel";

export const PULSE_MS = 30_000;

interface RealSnapshot {
  users: number | null;
  revenue: number | null;
  productUsers: ReadonlyMap<string, number | null>;
  productRevenue: ReadonlyMap<string, number | null>;
  betReadings: ReadonlyMap<string, BetRead>;
  stripe: StripeAnswer | null;
}

interface BetRead {
  reading: number | null;
  at: number;
}

/** Stripe took the key, turned it away (401/403), or never answered, which says nothing either way. */
export type StripeAnswer = "accepted" | "refused" | "unanswered";

const stripeGet = (endpoint: string, key: string) =>
  getJson(`${STRIPE_API}${endpoint}`, stripeHeaders(key));

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

interface KeptCharge {
  cents: number;
  created: number;
}

interface Revenue {
  total: number;
  byProduct: ReadonlyMap<string, number>;
  byBet: ReadonlyMap<string, readonly KeptCharge[]>;
}

const credit = (bucket: Map<string, number>, tag: string | undefined, kept: number) => {
  if (tag !== undefined) {
    bucket.set(tag, (bucket.get(tag) ?? 0) + kept / 100);
  }
};

const fileCharge = (
  bucket: Map<string, KeptCharge[]>,
  tag: string | undefined,
  kept: KeptCharge,
) => {
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

const keptBy = (revenue: Revenue, betId: string, until: number) =>
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
) => {
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
      return { byBet, byProduct, total: cents / 100 } satisfies Revenue | null;
    }
  }

  return null;
};

const stripeCharges = (key: string, since: number | null, countTest: boolean) => {
  const created = since === null ? "" : `&created[gte]=${Math.floor(since / 1000)}`;

  return sumCharges(
    (after) =>
      stripeGet(`/v1/charges?limit=100${created}${after ? `&starting_after=${after}` : ""}`, key),
    countTest,
  );
};

interface StripeSnapshot {
  at: number;
  charges: Revenue | null;
  bets: Revenue | null;
  answer: StripeAnswer;
}

/**
 * The key revenue is read with: the founder's own, which makes every payment link, so its
 * account is the one a bet's tagged money lands on.
 */
export const stripeCredential = () => getSecret(STRIPE_SECRET_KEY);

const countsTestMoney = () => process.env.IDLEBIZ_COUNT_TEST_MONEY === "1";

const countsNoMoney = (key: string) => !countsTestMoney() && isTestKey(key);

/** Whether Stripe is read with a key in test mode, whose charges count for nothing. */
export const stripeInTestMode = () => {
  const key = stripeCredential();

  return key !== null && countsNoMoney(key);
};

/**
 * Why no source would read what `bet` claims, in the words the lead should act
 * on, or null when one can: the founder's Stripe key for money, its product's
 * Vercel project for visitors. A window over a number nothing reads could only
 * close on no reading at all.
 */
export const measureRefusal = (bet: Bet, product: Product | null) => {
  if (bet.claim.metric === "revenue") {
    const key = stripeCredential();

    if (key === null) {
      return 'No source reads revenue yet — request_integration "stripe" for the founder to add the Stripe key IdleBiz charges with in the Budget panel. Then measure_bet again.';
    }

    return countsNoMoney(key)
      ? 'Stripe is in test mode — no charge counts. Ask the founder to swap the Stripe key IdleBiz charges with for a live one in the Budget panel (request_integration "stripe"), then measure_bet again.'
      : null;
  }

  return product?.vercel && getSecret(VERCEL_TOKEN)
    ? null
    : `No source reads users of ${product?.name ?? bet.productId} yet — ask the founder to bind Vercel to it (request_integration "vercel"), then measure_bet again.`;
};

const STRIPE_TTL_MS = 10 * 60_000;

let stripeRead: {
  countTest: boolean;
  key: string;
  noMoney: boolean;
  since: number | null;
  snapshot: StripeSnapshot;
} | null = null;

/** Drop the kept read, so the next pulse asks Stripe again whatever key it reads with. */
export const forgetStripeRead = () => {
  stripeRead = null;
};

const settled = <T>(read: PromiseSettledResult<T | null>) =>
  read.status === "fulfilled" ? read.value : null;

const refusedRead = (read: PromiseSettledResult<unknown>) =>
  read.status === "rejected" && read.reason instanceof HttpError && read.reason.refused;

const answerOf = (reads: readonly PromiseSettledResult<unknown>[]) => {
  if (reads.some(refusedRead)) {
    return "refused" satisfies StripeAnswer;
  }

  return (
    reads.some((read) => read.status === "fulfilled") ? "accepted" : "unanswered"
  ) satisfies StripeAnswer;
};

const stripeSnapshot = async (
  key: string | null,
  since: number | null,
  closes: readonly number[],
) => {
  const now = Date.now();

  if (key === null) {
    return { answer: "unanswered", at: now, bets: null, charges: null } satisfies StripeSnapshot;
  }

  const countTest = countsTestMoney();
  const noMoney = countsNoMoney(key);

  const kept =
    stripeRead?.key === key &&
    stripeRead.since === since &&
    stripeRead.countTest === countTest &&
    stripeRead.noMoney === noMoney
      ? stripeRead.snapshot
      : null;

  if (
    kept &&
    now - kept.at < STRIPE_TTL_MS &&
    !closes.some((until) => kept.at < until && until <= now)
  ) {
    return kept;
  }

  const reads = await Promise.allSettled([
    stripeCharges(key, null, countTest),
    since === null || noMoney ? null : stripeCharges(key, since, countTest),
  ]);

  const [charges, bets] = reads;

  const snapshot: StripeSnapshot = {
    answer: answerOf([charges]),
    at: now,
    bets: settled(bets),
    charges: settled(charges),
  };

  if (reads.every((read) => read.status === "fulfilled" || refusedRead(read))) {
    stripeRead = { countTest, key, noMoney, since, snapshot };
  }

  return snapshot;
};

const productVisitors = async (products: readonly Product[], token: string | null) => {
  const bound = products.flatMap(({ id, vercel }) => (vercel ? [{ id, vercel }] : []));

  const counts = await Promise.all(
    bound.map(({ vercel }) =>
      token ? webAnalyticsVisitors(vercel, token) : Promise.resolve(null),
    ),
  );

  const each = new Map(bound.map(({ id }, i) => [id, counts[i] ?? null]));
  const known = counts.filter((n): n is number => n !== null);

  return {
    each,
    total:
      known.length > 0 && known.length === counts.length ? known.reduce((a, b) => a + b, 0) : null,
  } satisfies { each: Map<string, number | null>; total: number | null };
};

const betReading = async (
  bet: Bet,
  products: readonly Product[],
  stripe: StripeSnapshot,
  vercelToken: string | null,
  now: number,
) => {
  const closes = bet.state.kind === "measuring" ? bet.state.until : Infinity;

  if (bet.claim.metric === "revenue") {
    return {
      at: stripe.at,
      reading: stripe.bets ? keptBy(stripe.bets, bet.id, closes) : null,
    } satisfies BetRead;
  }

  const deploy = products.find((p) => p.id === bet.productId)?.vercel;

  return {
    at: now,
    reading:
      deploy && vercelToken
        ? await webAnalyticsVisitors(deploy, vercelToken, {
            span: { since: bet.createdAt, until: Math.min(now, closes) },
            under: bet.claim.landingPath,
          })
        : null,
  } satisfies BetRead;
};

const revenueSince = (bets: readonly Bet[]) => {
  const opened = bets.flatMap((bet) => (bet.claim.metric === "revenue" ? [bet.createdAt] : []));

  return opened.length > 0 ? Math.min(...opened) : null;
};

const revenueCloses = (bets: readonly Bet[]) =>
  bets.flatMap((bet) =>
    bet.claim.metric === "revenue" && bet.state.kind === "measuring" ? [bet.state.until] : [],
  );

/** `key` is the founder's `stripeCredential`; `bets` are the live ones: a closed bet's number is settled. */
export const fetchRealMetrics = async (
  key: string | null,
  products: readonly Product[],
  bets: readonly Bet[],
) => {
  const now = Date.now();
  const vercelToken = getSecret(VERCEL_TOKEN);

  const [stripe, vercel] = await Promise.all([
    stripeSnapshot(key, revenueSince(bets), revenueCloses(bets)),
    productVisitors(products, vercelToken),
  ]);

  const { charges } = stripe;

  const readings = await Promise.all(
    bets.map(
      async (bet) =>
        [bet.id, await betReading(bet, products, stripe, vercelToken, now)] satisfies [
          string,
          BetRead,
        ],
    ),
  );

  return {
    betReadings: new Map(readings),
    productRevenue: new Map(
      products.map((p) => [p.id, charges ? (charges.byProduct.get(p.id) ?? 0) : null]),
    ),
    productUsers: vercel.each,
    revenue: charges?.total ?? null,
    stripe: key === null ? null : stripe.answer,
    users: vercel.total,
  } satisfies RealSnapshot;
};
