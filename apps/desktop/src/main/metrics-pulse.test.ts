import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-pulse-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("./store/store");
const { PULSE_MS } = await import("./metrics");
const { companyDir } = await import("./paths");
const { metricsPulse } = await import("./metrics-pulse");

const BOOT = 1_000_000;
const HOUR = 3_600_000;

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
  vi.useFakeTimers({ now: BOOT });
});

afterEach(() => {
  metricsPulse.stop();
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env["IDLEBIZ_ROOT_DIR"];
  } else {
    process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
  }
});

describe("metricsPulse.pulsingSince", () => {
  it("is null until the pulse starts and once it stops", () => {
    expect(metricsPulse.pulsingSince(Date.now())).toBeNull();
    metricsPulse.start();
    expect(metricsPulse.pulsingSince(Date.now())).toBe(BOOT);
    metricsPulse.stop();
    expect(metricsPulse.pulsingSince(Date.now())).toBeNull();
  });

  it("holds while the pulse keeps beating", () => {
    metricsPulse.start();
    vi.advanceTimersByTime(10 * PULSE_MS);
    expect(metricsPulse.pulsingSince(Date.now())).toBe(BOOT);
  });

  it("is null on waking before the pulse beats again, then counts from that beat", () => {
    metricsPulse.start();
    vi.setSystemTime(BOOT + HOUR);
    expect(metricsPulse.pulsingSince(Date.now())).toBeNull();
    vi.advanceTimersByTime(PULSE_MS);
    expect(metricsPulse.pulsingSince(Date.now())).toBe(BOOT + HOUR + PULSE_MS);
  });
});

describe("a pulse", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lands each product's and bet's numbers when the company's cannot write", async () => {
    writeFileSync(
      path.join(root, "secrets.json"),
      JSON.stringify({ STRIPE_SECRET_KEY: "sk_pulse" }),
    );
    const company = store.foundCompany({
      budget: { mode: "infinite" },
      businessType: "software",
      founderName: "Kai",
      founderSpriteSeed: "seed",
      hires: [
        {
          name: "Priya",
          persona: "ships",
          role: "engineer",
          runner: "claude",
          spriteSeed: "Priya",
          title: "Engineer",
        },
      ],
      mission: "ship",
      name: "Acme",
    });
    const productId = store.listProducts()[0]?.id ?? "";
    const bet = store.openBet({
      budgetUsd: 5,
      hypothesis: "a paid tier sells",
      metric: "revenue",
      productId,
      target: 20,
      title: "Paid tier",
      windowHours: 24,
    });
    const sale = {
      amount_captured: 700,
      amount_refunded: 0,
      captured: true,
      created: BOOT / 1000,
      currency: "usd",
      id: "ch_1",
      livemode: true,
      metadata: { bet: bet.id, product: productId },
      paid: true,
    };
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve(
        Response.json(url.includes("/v1/charges") ? { data: [sale] } : { total_count: 1 }),
      ),
    );
    const dir = companyDir(company.id);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    chmodSync(dir, 0o555);
    try {
      metricsPulse.now();
      await vi.waitFor(() => expect(store.getBet(bet.id)?.reading).toBe(7));
      expect(logged).toHaveBeenCalledWith("[company metrics]", expect.anything());
    } finally {
      chmodSync(dir, 0o755);
      logged.mockRestore();
    }
    expect(store.getProduct(productId)?.revenueUsd).toBe(7);
    expect(store.getCompany()?.revenueUsd).toBeNull();
  });
});
