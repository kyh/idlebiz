import * as store from "@/main/store/store";
import { publishActivity } from "@/main/activity";
import { report } from "@/main/lib/report";
import { PULSE_MS, fetchRealMetrics, stripeCredential } from "@/main/metrics";
import { readMetricsConfig } from "@/main/store/metrics-config";
import { noteStripeRead } from "@/main/stripe-connect";
import { isClosed } from "@/shared/bets";

// The real numbers, read on a beat and written where they belong: the company,
// each product, and each live bet's reading — which, with how long the pulse
// has been asking, is all the evaluator ever judges a bet by.

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

// A beat later than this after the last one means the machine slept in
// between, so nothing asked the sources: the streak starts again.
const BREAK_MS = 2 * PULSE_MS;
interface Streak {
  since: number;
  last: number;
}
let streak: Streak | null = null;

const unbrokenAt = (at: number): Streak | null =>
  streak !== null && at - streak.last <= BREAK_MS ? streak : null;

const read = async (): Promise<void> => {
  const company = store.getCompany();
  if (!company) {
    return;
  }
  const products = store.listProducts();
  const credential = stripeCredential(readMetricsConfig(company.id));
  if (credential === null && products.every((p) => p.vercel === null)) {
    noteStripeRead(company.id, null);
    return;
  }
  const bets = store.listBets().filter((b) => !isClosed(b));
  const snap = await fetchRealMetrics(credential, products, bets);
  store.setRealMetrics(snap);
  for (const product of products) {
    store.setProductMetrics(product.id, {
      revenue: snap.productRevenue.get(product.id) ?? null,
      users: snap.productUsers.get(product.id) ?? null,
    });
  }
  for (const [betId, { reading, at }] of snap.betReadings) {
    store.setBetReading(betId, reading, at);
  }
  noteStripeRead(company.id, snap.stripe);
  publishActivity(
    { kind: "metrics.pulse", payload: { revenue: snap.revenue, users: snap.users } },
    { persist: false },
  );
};

/** Read now, unless a read is already out: a slow provider must not let pulses stack, or a late one overwrites a newer reading. */
const now = async (): Promise<void> => {
  if (inFlight) {
    return;
  }
  inFlight = true;
  try {
    await read();
  } catch (error) {
    report("pulse", error);
  } finally {
    inFlight = false;
  }
};

const beat = (): void => {
  const at = Date.now();
  streak = { last: at, since: unbrokenAt(at)?.since ?? at };
  void now();
};

export const metricsPulse = {
  now: (): void => {
    void now();
  },
  /** Since when the pulse has asked the sources without a break, or null if it is not asking now: what a closed window's grace is counted on. */
  pulsingSince: (at: number): number | null => unbrokenAt(at)?.since ?? null,
  /** Beat now and on every pulse: a window that closed while the app was off gets its fresh reading at once. */
  start: (): void => {
    if (timer) {
      return;
    }
    timer = setInterval(beat, PULSE_MS);
    beat();
  },
  stop: (): void => {
    if (timer) {
      clearInterval(timer);
    }
    timer = null;
    streak = null;
  },
};
