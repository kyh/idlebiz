import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bet } from "@/shared/bets";
import type { StripeCredential } from "./metrics";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-metrics-"));
const secretsFile = path.join(root, "secrets.json");
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const { countPages, fetchRealMetrics, stripeCredential, sumCharges } = await import("./metrics");

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env["IDLEBIZ_ROOT_DIR"];
  } else {
    process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
  }
});

const charge = (id: string, amount: number, metadata: Record<string, string> = {}) => ({
  amount,
  amount_refunded: 0,
  id,
  metadata,
  paid: true,
});

const rows = (ids: string[], hasMore: boolean) => ({
  data: ids.map((id) => ({ id })),
  has_more: hasMore,
});

const revenueBet = (id: string, createdAt: number): Bet => ({
  budgetUsd: 5,
  claim: { metric: "revenue" },
  companyId: "co",
  createdAt,
  hypothesis: "a paid tier sells",
  id,
  productId: "app",
  reading: null,
  spentUsd: 0,
  state: { kind: "open" },
  target: 20,
  title: id,
  windowHours: 24,
});

/** Answer Stripe by endpoint, and keep what was asked. */
const stripe = (answer: (endpoint: string) => Response): string[] => {
  const asked: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    const endpoint = url.replace("https://api.stripe.com", "");
    asked.push(endpoint);
    return Promise.resolve(answer(endpoint));
  });
  return asked;
};
const down = () => new Response("{}", { status: 500 });

describe("sumCharges", () => {
  it("follows the list past its first hundred", async () => {
    const asked: (string | null)[] = [];
    const revenue = await sumCharges((after) => {
      asked.push(after);
      return Promise.resolve(
        after === null
          ? { data: [charge("ch_1", 1000), charge("ch_2", 500)], has_more: true }
          : { data: [charge("ch_3", 250)], has_more: false },
      );
    });
    expect(revenue?.total).toBe(17.5);
    expect(asked).toEqual([null, "ch_2"]);
  });

  it("credits a product with what its tag claims, in the same read", async () => {
    const revenue = await sumCharges(() =>
      Promise.resolve({
        data: [
          charge("ch_1", 1000, { product: "app" }),
          charge("ch_2", 500, { product: "app" }),
          charge("ch_3", 250),
        ],
      }),
    );
    expect(revenue?.total).toBe(17.5);
    expect([...(revenue?.byProduct ?? [])]).toEqual([["app", 15]]);
  });

  it("counts what was kept: not unpaid charges, not refunds", async () => {
    const revenue = await sumCharges(() =>
      Promise.resolve({
        data: [
          { ...charge("ch_1", 1000), amount_refunded: 1000 },
          { ...charge("ch_2", 1000), amount_refunded: 300 },
          { ...charge("ch_3", 900), paid: false },
        ],
      }),
    );
    expect(revenue?.total).toBe(7);
  });

  it("reports nothing rather than half a total", async () => {
    const revenue = await sumCharges((after) =>
      Promise.resolve(
        after === null ? { data: [charge("ch_1", 1000)], has_more: true } : "rate limited",
      ),
    );
    expect(revenue).toBeNull();
  });

  it("reports nothing when the list outruns the page cap", async () => {
    const revenue = await sumCharges(() =>
      Promise.resolve({ data: [charge("ch_1", 100)], has_more: true }),
    );
    expect(revenue).toBeNull();
  });
});

describe("countPages", () => {
  it("counts every row across the list", async () => {
    const count = await countPages((after) =>
      Promise.resolve(after === null ? rows(["cus_1", "cus_2"], true) : rows(["cus_3"], false)),
    );
    expect(count).toBe(3);
  });

  it("reports nothing rather than a partial count", async () => {
    const count = await countPages((after) =>
      Promise.resolve(after === null ? rows(["cus_1"], true) : "rate limited"),
    );
    expect(count).toBeNull();
  });

  it("reports nothing when the list outruns the page cap", async () => {
    const count = await countPages(() => Promise.resolve(rows(["cus_1"], true)));
    expect(count).toBeNull();
  });
});

describe("stripeCredential", () => {
  const stripeAccount = { accountId: "acct_1", connectedAt: 0, livemode: false };

  beforeEach(() => rmSync(secretsFile, { force: true }));

  it("leaves a Connect token to the company that connected it", () => {
    writeFileSync(secretsFile, '{"STRIPE_CONNECT_TOKEN":"connected"}');

    expect(stripeCredential(null)).toBeNull();
    expect(stripeCredential({})).toBeNull();
    expect(stripeCredential({ stripeAccount })).toEqual({ key: "connected", via: "connect" });
  });

  it("reads the founder's own key for every company", () => {
    writeFileSync(secretsFile, '{"STRIPE_CONNECT_TOKEN":"connected","STRIPE_SECRET_KEY":"own"}');

    expect(stripeCredential(null)).toEqual({ key: "own", via: "own" });
    expect(stripeCredential({})).toEqual({ key: "own", via: "own" });
    expect(stripeCredential({ stripeAccount })).toEqual({ key: "connected", via: "connect" });
  });

  it("takes a key left blank for no key", () => {
    writeFileSync(secretsFile, '{"STRIPE_CONNECT_TOKEN":"","STRIPE_SECRET_KEY":""}');

    expect(stripeCredential({ stripeAccount })).toBeNull();
  });
});

describe("fetchRealMetrics", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 401 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports a refused Connect token as a revoked connection", async () => {
    const snap = await fetchRealMetrics({ key: "revoked", via: "connect" }, [], []);

    expect(snap.connectRevoked).toBe(true);
    expect(snap.revenue).toBeNull();
  });

  it("leaves the connection alone when the founder's own key is refused", async () => {
    const snap = await fetchRealMetrics({ key: "rolled", via: "own" }, [], []);

    expect(snap.connectRevoked).toBe(false);
    expect(snap.revenue).toBeNull();
  });
});

describe("fetchRealMetrics reading Stripe", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks customer search to expand its total", async () => {
    const asked = stripe((endpoint) =>
      endpoint.startsWith("/v1/customers/search") ? Response.json({ total_count: 42 }) : down(),
    );

    const snap = await fetchRealMetrics({ key: "search", via: "own" }, [], []);

    expect(asked).toContain("/v1/customers/search?query=created%3E0&limit=1&expand[]=total_count");
    expect(snap.users).toBe(42);
  });

  it("reads a bet's money from the charges since the oldest live revenue bet opened", async () => {
    const asked = stripe((endpoint) => {
      if (endpoint.startsWith("/v1/charges?limit=100&created[gte]=")) {
        return Response.json({ data: [charge("ch_new", 700, { bet: "pricing" })] });
      }
      if (endpoint.startsWith("/v1/charges")) {
        return Response.json({ data: [charge("ch_old", 5000), charge("ch_new", 700)] });
      }
      return Response.json({ total_count: 1 });
    });
    const bets = [revenueBet("pricing", 1_700_000_000_500), revenueBet("later", 1_800_000_000_000)];

    const snap = await fetchRealMetrics({ key: "bets", via: "own" }, [], bets);

    expect(asked).toContain("/v1/charges?limit=100&created[gte]=1700000000");
    expect(snap.revenue).toBe(57);
    expect([...snap.betReadings]).toEqual([
      ["pricing", 7],
      ["later", 0],
    ]);
  });

  it("keeps the money it read when the customer count fails", async () => {
    const asked = stripe((endpoint) =>
      endpoint.startsWith("/v1/charges") ? Response.json({ data: [charge("ch_1", 900)] }) : down(),
    );

    const snap = await fetchRealMetrics({ key: "flaky", via: "own" }, [], []);
    const first = asked.length;
    await fetchRealMetrics({ key: "flaky", via: "own" }, [], []);

    expect(snap.revenue).toBe(9);
    expect(snap.users).toBeNull();
    expect(snap.connectRevoked).toBe(false);
    expect(asked.length).toBe(first * 2);
  });

  it("keeps a read, even one that came back short, until a bet moves where it starts", async () => {
    const asked = stripe((endpoint) =>
      endpoint.startsWith("/v1/charges")
        ? Response.json({ data: [charge("ch_1", 100)], has_more: true })
        : Response.json({ total_count: 3 }),
    );
    const credential: StripeCredential = { key: "capped", via: "own" };

    const snap = await fetchRealMetrics(credential, [], []);
    const first = asked.length;
    await fetchRealMetrics(credential, [], []);
    const again = asked.length;
    await fetchRealMetrics(credential, [], [revenueBet("pricing", 0)]);

    expect(snap.revenue).toBeNull();
    expect(snap.users).toBe(3);
    expect(again).toBe(first);
    expect(asked.length).toBeGreaterThan(again);
  });
});
