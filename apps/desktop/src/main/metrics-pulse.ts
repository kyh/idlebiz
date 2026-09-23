import * as store from "@/main/store/store";
import { publishActivity } from "@/main/activity";
import { report } from "@/main/lib/report";
import { PULSE_MS, fetchRealMetrics, stripeCredential } from "@/main/metrics";
import { readMetricsConfig } from "@/main/store/metrics-config";
import { noteStripeRead } from "@/main/stripe-connect";
import { isClosed } from "@/shared/bets";

// The real numbers, read on a beat and written where they belong: the company,
// each product, and each live bet's reading — which is all the evaluator ever
// judges a bet by.

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

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
  for (const [betId, reading] of snap.betReadings) {
    store.setBetReading(betId, reading);
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

export const metricsPulse = {
  now: (): void => {
    void now();
  },
  start: (): void => {
    timer ??= setInterval(() => {
      void now();
    }, PULSE_MS);
  },
  stop: (): void => {
    if (timer) {
      clearInterval(timer);
    }
    timer = null;
  },
};
