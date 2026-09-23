import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-metrics-"));
const secretsFile = path.join(root, "secrets.json");
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const { fetchRealMetrics, stripeCredential, sumCharges } = await import("./metrics");

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env["IDLEBIZ_ROOT_DIR"];
  } else {
    process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
  }
});

const charge = (id: string, amount: number, product?: string) => {
  const metadata: Record<string, string> = product === undefined ? {} : { product };
  return { amount, amount_refunded: 0, id, metadata, paid: true };
};

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
        data: [charge("ch_1", 1000, "app"), charge("ch_2", 500, "app"), charge("ch_3", 250)],
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
