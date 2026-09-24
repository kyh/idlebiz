import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { judge } from "@/shared/bets";
import type { Bet } from "@/shared/bets";
import type { Product } from "@/shared/domain";
import type { StripeCredential } from "./metrics";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-metrics-"));
const secretsFile = path.join(root, "secrets.json");
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const { countPages, fetchRealMetrics, stripeCredential, stripeInTestMode, sumCharges } =
  await import("./metrics");

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
  amount_captured: amount,
  amount_refunded: 0,
  captured: true,
  created: 1_700_000_000,
  currency: "usd",
  id,
  livemode: true,
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
  readAt: null,
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

/** Count these visits over whatever span each query names, and keep the queries. */
const visits = (at: readonly number[]): URLSearchParams[] => {
  const asked: URLSearchParams[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    const query = new URL(url).searchParams;
    asked.push(query);
    const since = Date.parse(query.get("since") ?? "");
    const until = Date.parse(query.get("until") ?? "");
    const counted = at.filter(
      (t) => Number.isNaN(since) || Number.isNaN(until) || (since <= t && t <= until),
    );
    return Promise.resolve(Response.json({ data: { visitors: counted.length } }));
  });
  return asked;
};

/** What a read counts while test money does not. */
const liveMoney = (fetchPage: Parameters<typeof sumCharges>[0]) => sumCharges(fetchPage, false);

describe("sumCharges", () => {
  it("follows the list past its first hundred", async () => {
    const asked: (string | null)[] = [];
    const revenue = await liveMoney((after) => {
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
    const revenue = await liveMoney(() =>
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
    const revenue = await liveMoney(() =>
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

  it("counts no authorization that was never captured", async () => {
    const revenue = await liveMoney(() =>
      Promise.resolve({
        data: [
          charge("ch_1", 1000, { bet: "x", product: "app" }),
          { ...charge("ch_2", 5000, { bet: "x", product: "app" }), captured: false },
        ],
      }),
    );
    expect(revenue?.total).toBe(10);
    expect([...(revenue?.byProduct ?? [])]).toEqual([["app", 10]]);
    expect([...(revenue?.byBet ?? [])]).toEqual([
      ["x", [{ cents: 1000, created: 1_700_000_000_000 }]],
    ]);
  });

  it("counts what a partial capture took, not what it authorized", async () => {
    const revenue = await liveMoney(() =>
      Promise.resolve({
        data: [{ ...charge("ch_1", 5000, { bet: "x", product: "app" }), amount_captured: 1000 }],
      }),
    );
    expect(revenue?.total).toBe(10);
    expect([...(revenue?.byBet ?? [])]).toEqual([
      ["x", [{ cents: 1000, created: 1_700_000_000_000 }]],
    ]);
  });

  it("reads no other currency's minor units as cents", async () => {
    const revenue = await liveMoney(() =>
      Promise.resolve({
        data: [{ ...charge("ch_1", 2000, { bet: "x", product: "app" }), currency: "jpy" }],
      }),
    );
    expect(revenue?.total).toBe(0);
    expect(revenue?.byProduct.size).toBe(0);
    expect(revenue?.byBet.size).toBe(0);
  });

  it("counts a test-mode charge nowhere unless test money counts", async () => {
    const page = {
      data: [
        charge("ch_live", 1000, { bet: "x", product: "app" }),
        { ...charge("ch_test", 5000, { bet: "x", product: "app" }), livemode: false },
      ],
    };

    const live = await sumCharges(() => Promise.resolve(page), false);
    const all = await sumCharges(() => Promise.resolve(page), true);

    expect(live?.total).toBe(10);
    expect([...(live?.byProduct ?? [])]).toEqual([["app", 10]]);
    expect([...(live?.byBet ?? [])]).toEqual([
      ["x", [{ cents: 1000, created: 1_700_000_000_000 }]],
    ]);
    expect(all?.total).toBe(60);
    expect([...(all?.byProduct ?? [])]).toEqual([["app", 60]]);
    expect(all?.byBet.get("x")).toHaveLength(2);
  });

  it("reports nothing rather than half a total", async () => {
    const revenue = await liveMoney((after) =>
      Promise.resolve(
        after === null ? { data: [charge("ch_1", 1000)], has_more: true } : "rate limited",
      ),
    );
    expect(revenue).toBeNull();
  });

  it("reports nothing for a page whose charges say not when they were made", async () => {
    const undated = {
      amount_captured: 1000,
      captured: true,
      currency: "usd",
      id: "ch_1",
      metadata: { bet: "x" },
      paid: true,
    };
    const revenue = await liveMoney(() => Promise.resolve({ data: [undated] }));
    expect(revenue).toBeNull();
  });

  it("reports nothing when the list outruns the page cap", async () => {
    const revenue = await liveMoney(() =>
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

describe("stripeInTestMode", () => {
  beforeEach(() => rmSync(secretsFile, { force: true }));
  afterEach(() => vi.unstubAllEnvs());

  it("takes a test-mode key, secret or restricted, for one whose money counts for nothing", () => {
    expect(stripeInTestMode("co")).toBe(false);
    writeFileSync(secretsFile, '{"STRIPE_SECRET_KEY":"sk_live_1"}');
    expect(stripeInTestMode("co")).toBe(false);
    writeFileSync(secretsFile, '{"STRIPE_SECRET_KEY":"sk_test_1"}');
    expect(stripeInTestMode("co")).toBe(true);
    writeFileSync(secretsFile, '{"STRIPE_SECRET_KEY":"rk_test_1"}');
    expect(stripeInTestMode("co")).toBe(true);
  });

  it("lets a test-mode key's money count under IDLEBIZ_COUNT_TEST_MONEY=1", () => {
    writeFileSync(secretsFile, '{"STRIPE_SECRET_KEY":"sk_test_1"}');
    vi.stubEnv("IDLEBIZ_COUNT_TEST_MONEY", "1");
    expect(stripeInTestMode("co")).toBe(false);
  });
});

describe("fetchRealMetrics", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("{}", { status: 401 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports a refused Connect token", async () => {
    const snap = await fetchRealMetrics({ key: "revoked", via: "connect" }, [], []);

    expect(snap.stripe).toEqual({ answer: "refused", via: "connect" });
    expect(snap.revenue).toBeNull();
  });

  it("reports a refused own key as the founder's", async () => {
    const snap = await fetchRealMetrics({ key: "rolled", via: "own" }, [], []);

    expect(snap.stripe).toEqual({ answer: "refused", via: "own" });
    expect(snap.revenue).toBeNull();
  });

  it("says nothing of Stripe when the company has no key", async () => {
    const snap = await fetchRealMetrics(null, [], []);

    expect(snap.stripe).toBeNull();
  });
});

describe("fetchRealMetrics reading Stripe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("reads every Stripe answer at the pinned API version", async () => {
    const versions: (string | null)[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      versions.push(new Headers(init.headers).get("Stripe-Version"));
      return Promise.resolve(Response.json({ data: [], total_count: 0 }));
    });

    await fetchRealMetrics({ key: "pinned", via: "own" }, [], [revenueBet("pricing", 0)]);

    expect(versions).toHaveLength(3);
    expect(new Set(versions)).toEqual(new Set(["2025-03-31.basil"]));
  });

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
      ["pricing", { at: expect.any(Number), reading: 7 }],
      ["later", { at: expect.any(Number), reading: 0 }],
    ]);
  });

  it("gives a bet no reading on a test key unless IDLEBIZ_COUNT_TEST_MONEY=1, reading again when it flips", async () => {
    const asked = stripe((endpoint) =>
      endpoint.startsWith("/v1/charges")
        ? Response.json({ data: [{ ...charge("ch_1", 700, { bet: "pricing" }), livemode: false }] })
        : Response.json({ total_count: 1 }),
    );
    const credential: StripeCredential = { key: "sk_test_flag", via: "own" };
    const bets = [revenueBet("pricing", 0)];

    const live = await fetchRealMetrics(credential, [], bets);
    const first = asked.length;
    vi.stubEnv("IDLEBIZ_COUNT_TEST_MONEY", "1");
    const test = await fetchRealMetrics(credential, [], bets);

    expect(live.revenue).toBe(0);
    expect(live.betReadings.get("pricing")?.reading).toBeNull();
    expect(asked.slice(0, first).filter((endpoint) => endpoint.includes("created[gte]"))).toEqual(
      [],
    );
    expect(asked.slice(first)).toContain("/v1/charges?limit=100&created[gte]=0");
    expect(test.revenue).toBe(7);
    expect(test.betReadings.get("pricing")?.reading).toBe(7);
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
    expect(snap.stripe).toEqual({ answer: "accepted", via: "own" });
    expect(asked.length).toBe(first * 2);
  });

  it("keeps a read a restricted key was refused part of", async () => {
    const asked = stripe((endpoint) =>
      endpoint.startsWith("/v1/charges")
        ? Response.json({ data: [charge("ch_1", 900)] })
        : new Response("{}", { status: 403 }),
    );
    const credential: StripeCredential = { key: "restricted", via: "own" };

    const snap = await fetchRealMetrics(credential, [], []);
    const first = asked.length;
    const again = await fetchRealMetrics(credential, [], []);

    expect(snap.revenue).toBe(9);
    expect(again.stripe).toEqual({ answer: "refused", via: "own" });
    expect(asked.length).toBe(first);
  });

  it("takes a Stripe that never answered as neither taking nor refusing the key", async () => {
    stripe(down);

    const snap = await fetchRealMetrics({ key: "unreachable", via: "own" }, [], []);

    expect(snap.stripe).toEqual({ answer: "unanswered", via: "own" });
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

  it("reads again once a revenue bet's window closed after the kept read", async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
    const asked = stripe((endpoint) =>
      endpoint.startsWith("/v1/charges")
        ? Response.json({ data: [{ ...charge("ch_1", 700, { bet: "pricing" }), created: 900 }] })
        : Response.json({ total_count: 1 }),
    );
    const credential: StripeCredential = { key: "closing", via: "own" };
    const closing: Bet = {
      ...revenueBet("pricing", 0),
      state: { kind: "measuring", until: 1_060_000 },
    };

    await fetchRealMetrics(credential, [], [closing]);
    const first = asked.length;
    vi.setSystemTime(1_030_000);
    const kept = await fetchRealMetrics(credential, [], [closing]);
    const beforeClose = asked.length;
    vi.setSystemTime(1_090_000);
    const fresh = await fetchRealMetrics(credential, [], [closing]);

    expect(beforeClose).toBe(first);
    expect(kept.betReadings.get("pricing")).toEqual({ at: 1_000_000, reading: 7 });
    expect(asked.length).toBe(first * 2);
    expect(fresh.betReadings.get("pricing")).toEqual({ at: 1_090_000, reading: 7 });
  });

  it("judges a window that closed while the app slept on the money made inside it", async () => {
    const closes = 1_700_000_000_000;
    vi.useFakeTimers({ now: closes + 6 * 3_600_000, toFake: ["Date"] });
    stripe((endpoint) =>
      endpoint.startsWith("/v1/charges")
        ? Response.json({
            data: [
              { ...charge("ch_in", 1800, { bet: "pricing" }), created: closes / 1000 - 60 },
              { ...charge("ch_late", 500, { bet: "pricing" }), created: closes / 1000 + 60 },
              { ...charge("ch_open", 500, { bet: "later" }), created: closes / 1000 + 60 },
            ],
          })
        : Response.json({ total_count: 1 }),
    );
    const asleep: Bet = {
      ...revenueBet("pricing", 0),
      readAt: closes - 3_600_000,
      reading: 15,
      state: { kind: "measuring", until: closes },
    };

    const snap = await fetchRealMetrics(
      { key: "slept", via: "own" },
      [],
      [asleep, revenueBet("later", 0)],
    );
    const read = snap.betReadings.get("pricing");

    expect(read).toEqual({ at: Date.now(), reading: 18 });
    expect(snap.betReadings.get("later")?.reading).toBe(5);
    expect(
      judge(
        { ...asleep, readAt: read?.at ?? null, reading: read?.reading ?? null },
        Date.now(),
        null,
      ),
    ).toMatchObject({ kind: "killed", moved: 18 });
  });

  it("closes a window a test key read as unmeasured, never as a loss", async () => {
    const closes = 1_700_000_000_000;
    vi.useFakeTimers({ now: closes + 2 * 24 * 3_600_000, toFake: ["Date"] });
    stripe((endpoint) =>
      endpoint.startsWith("/v1/charges")
        ? Response.json({ data: [{ ...charge("ch_1", 700, { bet: "pricing" }), livemode: false }] })
        : Response.json({ total_count: 1 }),
    );
    const held: Bet = { ...revenueBet("pricing", 0), state: { kind: "measuring", until: closes } };

    const snap = await fetchRealMetrics({ key: "sk_test_held", via: "own" }, [], [held]);

    expect(snap.betReadings.get("pricing")?.reading).toBeNull();
    expect(judge(held, Date.now(), 0)).toMatchObject({
      kind: "killed",
      moved: null,
      reason: "Stripe never reported its revenue",
    });
  });
});

describe("fetchRealMetrics reading Vercel", () => {
  const HOUR = 3_600_000;
  const opened = Date.UTC(2026, 8, 21, 12);
  const closes = opened + 15 * HOUR;
  const woke = closes + 6 * HOUR;
  const app: Product = {
    companyId: "co",
    createdAt: 0,
    description: "An app.",
    id: "app",
    lastShipAt: null,
    name: "App",
    revenueUsd: null,
    ships: 0,
    users: null,
    vercel: { projectId: "prj_app", projectName: "app", teamId: null },
    workspaceDir: root,
  };
  const usersBet = (id: string, state: Bet["state"]): Bet => ({
    ...revenueBet(id, opened),
    claim: { landingPath: `/b/${id}`, metric: "users" },
    state,
    target: 50,
  });

  beforeEach(() => writeFileSync(secretsFile, '{"VERCEL_TOKEN":"token"}'));
  afterEach(() => {
    rmSync(secretsFile, { force: true });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks for a measuring bet's visitors only up to its window's close", async () => {
    vi.useFakeTimers({ now: woke, toFake: ["Date"] });
    const asked = visits([]);

    await fetchRealMetrics(
      null,
      [app],
      [
        usersBet("launch", { kind: "measuring", until: closes }),
        usersBet("promo", { kind: "open" }),
      ],
    );
    const until = (landing: string) =>
      asked.find((query) => query.get("filter")?.includes(landing))?.get("until");

    expect(until("/b/launch")).toBe(new Date(closes).toISOString());
    expect(until("/b/promo")).toBe(new Date(woke).toISOString());
  });

  it("judges a window that closed while the app slept on the visits inside it", async () => {
    const lastRead = closes - 4 * HOUR;
    vi.useFakeTimers({ now: woke, toFake: ["Date"] });
    visits([
      ...Array.from({ length: 45 }, () => lastRead - HOUR),
      ...Array.from({ length: 3 }, () => closes - HOUR),
      ...Array.from({ length: 6 }, () => closes + HOUR),
    ]);
    const asleep: Bet = {
      ...usersBet("launch", { kind: "measuring", until: closes }),
      readAt: lastRead,
      reading: 45,
    };

    const snap = await fetchRealMetrics(null, [app], [asleep]);
    const read = snap.betReadings.get("launch");

    expect(read).toEqual({ at: woke, reading: 48 });
    expect(
      judge({ ...asleep, readAt: read?.at ?? null, reading: read?.reading ?? null }, woke, null),
    ).toMatchObject({ kind: "killed", moved: 48 });
  });
});
