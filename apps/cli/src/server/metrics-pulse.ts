import * as store from "./store/store";
import { publishActivity } from "./activity";
import { switchOffRetiredLinks } from "./company-actions";
import { guarded, report } from "./lib/report";
import { PULSE_MS, fetchRealMetrics, stripeCredential } from "./metrics";
import { CHECKOUTS_READ_MS } from "./order-intake";
import { ORDER_TRACK_MS, pumpOrders } from "./order-pump";
import type { OrderBeat } from "./order-pump";
import { noteStripeRead } from "./stripe-key";
import { isClosed } from "@repo/domain/bets";

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let checkoutsReadAt: number | null = null;
let ordersTrackedAt: number | null = null;

const due = (last: number | null, at: number, every: number) => last === null || at - last >= every;

const orderBeat = (at: number) => {
  if (due(checkoutsReadAt, at, CHECKOUTS_READ_MS)) {
    checkoutsReadAt = at;
    ordersTrackedAt = at;

    return "read" satisfies OrderBeat;
  }

  if (due(ordersTrackedAt, at, ORDER_TRACK_MS)) {
    ordersTrackedAt = at;

    return "track" satisfies OrderBeat;
  }

  return "price" satisfies OrderBeat;
};

const BREAK_MS = 2 * PULSE_MS;

interface Streak {
  since: number;
  last: number;
}

let streak: Streak | null = null;

const unbrokenAt = (at: number) =>
  streak !== null && at - streak.last <= BREAK_MS ? streak : null;

const read = async () => {
  const company = store.getCompany();

  if (!company) {
    return;
  }

  const products = store.listProducts();
  const key = stripeCredential();

  if (key === null && products.every((p) => p.vercel === null)) {
    return;
  }

  const bets = store.listBets().filter((b) => !isClosed(b));
  const snap = await fetchRealMetrics(key, products, bets);
  guarded("company metrics", () => store.setRealMetrics(snap));

  for (const product of products) {
    guarded(`metrics of ${product.id}`, () => {
      store.setProductMetrics(product.id, {
        revenue: snap.productRevenue.get(product.id) ?? null,
        users: snap.productUsers.get(product.id) ?? null,
      });
    });
  }

  for (const [betId, { reading, at }] of snap.betReadings) {
    guarded(`reading of ${betId}`, () => store.setBetReading(betId, reading, at));
  }

  if (key !== null && snap.stripe !== null) {
    noteStripeRead(key, snap.stripe);
  }

  publishActivity(
    { kind: "metrics.pulse", payload: { revenue: snap.revenue, users: snap.users } },
    { persist: false },
  );
};

const now = async () => {
  if (inFlight) {
    return;
  }

  inFlight = true;

  try {
    await read();
  } catch (error) {
    report("pulse", error);
  }

  await switchOffRetiredLinks();

  try {
    const at = Date.now();
    await pumpOrders(at, orderBeat(at));
  } catch (error) {
    report("orders", error);
  } finally {
    inFlight = false;
  }
};

const beat = () => {
  const at = Date.now();
  streak = { last: at, since: unbrokenAt(at)?.since ?? at };
  void now();
};

export const metricsPulse = {
  now: () => {
    void now();
  },
  /** Since when the pulse has asked the sources without a break, or null if it is not asking now: what a closed window's grace is counted on. */
  pulsingSince: (at: number) => unbrokenAt(at)?.since ?? null,
  /** Beat now and on every pulse: a window that closed while the app was off gets its fresh reading at once. */
  start: () => {
    if (timer) {
      return;
    }

    timer = setInterval(beat, PULSE_MS);
    beat();
  },
  stop: () => {
    if (timer) {
      clearInterval(timer);
    }

    timer = null;
    streak = null;
    checkoutsReadAt = null;
    ordersTrackedAt = null;
  },
};
