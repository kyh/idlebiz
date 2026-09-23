import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, allocate, claimsCollide, dream, judge } from "@/shared/bets";
import type { Bet, BetState } from "@/shared/bets";

const HOUR = 3_600_000;

const bet = (patch: Partial<Bet> = {}): Bet => ({
  budgetUsd: 5,
  claim: { landingPath: "/b/bet", metric: "users" },
  companyId: "co",
  createdAt: 0,
  hypothesis: "a launch post brings visitors",
  id: "bet",
  productId: "app",
  reading: null,
  spentUsd: 0,
  state: { kind: "open" },
  target: 50,
  title: "Launch post",
  windowHours: 24,
  ...patch,
});

const closed = (id: string, productId: string, at: number, moved: number, spentUsd = 1): Bet => {
  const state: BetState =
    moved >= 50
      ? { closedAt: at + HOUR, kind: "won", moved }
      : { closedAt: at + HOUR, kind: "killed", moved, reason: "short" };
  return bet({ createdAt: at, id, productId, spentUsd, state });
};

const ledger = (bets: Bet[], products = ["app", "site"]) => ({
  bets,
  busy: new Map<string, number>(),
  products,
  proposalPending: false,
  runCostUsd: 1,
  stalled: new Set<string>(),
});

const measuring: BetState = { kind: "measuring", until: 10 };

describe("judge", () => {
  it("leaves an open bet alone while it has budget and no result", () => {
    expect(judge(bet({ reading: 20 }), 0)).toEqual({ kind: "open" });
  });

  it("wins the moment what it claims reaches the target", () => {
    expect(judge(bet({ reading: 50 }), 7)).toEqual({ closedAt: 7, kind: "won", moved: 50 });
  });

  it("does not start the clock just because the budget is spent", () => {
    expect(judge(bet({ reading: 20, spentUsd: 5 }), 0)).toEqual({ kind: "open" });
  });

  it("kills a bet whose window closed short", () => {
    expect(judge(bet({ reading: 20, state: measuring }), 10)).toMatchObject({
      kind: "killed",
      moved: 20,
      reason: "it brought 20 of 50 users",
    });
  });

  it("kills a bet nothing could ever measure", () => {
    expect(judge(bet({ state: measuring }), 10)).toMatchObject({ kind: "killed", moved: null });
  });

  it("never reopens a verdict", () => {
    const won: BetState = { closedAt: 1, kind: "won", moved: 50 };
    expect(judge(bet({ state: won }), 99)).toBe(won);
  });
});

const landing = (id: string, landingPath: string, productId = "app") =>
  bet({ claim: { landingPath, metric: "users" }, id, productId });

describe("claimsCollide", () => {
  it("lets bets with paths of their own run side by side", () => {
    expect(claimsCollide(landing("a", "/b/a"), landing("b", "/b/ab"))).toBe(false);
  });

  it("refuses a path another bet already covers, from above or below", () => {
    expect(claimsCollide(landing("a", "/guides"), landing("b", "/guides/late-fees"))).toBe(true);
    expect(claimsCollide(landing("a", "/guides/late-fees/"), landing("b", "/guides"))).toBe(true);
    expect(claimsCollide(landing("a", "/"), landing("b", "/b/b"))).toBe(true);
  });

  it("never collides across products, or over money, which is tagged per bet", () => {
    expect(claimsCollide(landing("a", "/"), landing("b", "/", "site"))).toBe(false);
    const revenue = bet({ claim: { metric: "revenue" }, id: "r" });
    expect(claimsCollide(revenue, bet({ claim: { metric: "revenue" }, id: "r2" }))).toBe(false);
    expect(claimsCollide(revenue, landing("a", "/"))).toBe(false);
  });
});

describe("allocate", () => {
  it("sends work to the product whose bets have paid", () => {
    const pick = allocate(
      ledger([
        closed("a", "app", 0, 100),
        closed("b", "site", 0, 0),
        bet({ id: "app-next", productId: "app" }),
        bet({ id: "site-next", productId: "site" }),
      ]),
      { explore: 0, plateau: 3 },
    );
    expect(pick).toEqual({ betId: "app-next", kind: "work" });
  });

  it("spreads idle hands across bets", () => {
    const pick = allocate(
      {
        ...ledger([bet({ id: "one" }), bet({ id: "two" })], ["app"]),
        busy: new Map([["one", 2]]),
      },
      DEFAULT_POLICY,
    );
    expect(pick).toEqual({ betId: "two", kind: "work" });
  });

  it("counts runs in flight against the budget before they bill", () => {
    const pick = allocate(
      { ...ledger([bet({ budgetUsd: 2, id: "tight" })], ["app"]), busy: new Map([["tight", 2]]) },
      DEFAULT_POLICY,
    );
    expect(pick.kind).toBe("propose");
  });

  it("sends nobody to a bet waiting on the founder", () => {
    const pick = allocate(
      { ...ledger([bet({ id: "blocked" })], ["app"]), stalled: new Set(["blocked"]) },
      DEFAULT_POLICY,
    );
    expect(pick.kind).toBe("propose");
  });

  it("has the lead settle a spent-out bet before opening another", () => {
    expect(allocate(ledger([bet({ id: "dry", spentUsd: 5 })], ["app"]), DEFAULT_POLICY)).toEqual({
      betId: "dry",
      kind: "settle",
    });
  });

  it("does not ask a lead already waiting on the founder to open another", () => {
    expect(allocate({ ...ledger([]), proposalPending: true }, DEFAULT_POLICY)).toEqual({
      kind: "wait",
    });
  });

  it("leaves a spent-out bet alone while its settle run is in flight or blocked", () => {
    const dry = [bet({ id: "dry", spentUsd: 5 })];
    const settling = { ...ledger(dry, ["app"]), busy: new Map([["dry", 1]]) };
    const blocked = { ...ledger(dry, ["app"]), stalled: new Set(["dry"]) };
    expect(allocate(settling, DEFAULT_POLICY).kind).not.toBe("settle");
    expect(allocate(blocked, DEFAULT_POLICY).kind).not.toBe("settle");
  });

  it("ignores bets on a killed product", () => {
    expect(allocate(ledger([bet({ productId: "gone" })]), DEFAULT_POLICY).kind).toBe("propose");
  });

  it("asks for new ground after a run of losses", () => {
    const losses = [0, 1, 2].map((i) => closed(`l${i}`, "app", i * HOUR, 0));
    expect(allocate(ledger(losses), DEFAULT_POLICY)).toMatchObject({
      kind: "propose",
      widen: true,
    });
  });

  it("proposes on the best proven product otherwise", () => {
    expect(allocate(ledger([closed("a", "site", 0, 100)]), { explore: 0, plateau: 3 })).toEqual({
      kind: "propose",
      productId: "site",
      widen: false,
    });
  });

  it("asks for a new product when the only one carries all the live bets it can", () => {
    const full = ["one", "two", "three"].map((id) => bet({ id, state: measuring }));
    expect(allocate(ledger(full, ["app"]), DEFAULT_POLICY)).toEqual({
      kind: "propose",
      productId: null,
      widen: true,
    });
  });

  it("waits when the portfolio is full and every product carries all it can", () => {
    const products = ["a", "b", "c", "d", "e"];
    const full = products.flatMap((productId) =>
      ["one", "two", "three"].map((n) =>
        bet({ id: `${productId}-${n}`, productId, state: measuring }),
      ),
    );
    expect(allocate(ledger(full, products), DEFAULT_POLICY)).toEqual({ kind: "wait" });
  });
});

describe("dream", () => {
  it("keeps the incumbent on thin history", () => {
    expect(dream(DEFAULT_POLICY, [closed("a", "app", 0, 100)])).toBe(DEFAULT_POLICY);
  });

  it("never swaps to a policy that replays worse", () => {
    const history = Array.from({ length: 10 }, (_, i) =>
      closed(`b${i}`, i % 2 === 0 ? "app" : "site", i * (HOUR / 2), i % 2 === 0 ? 100 : 0),
    );
    const next = dream(DEFAULT_POLICY, history);
    expect(next.explore).toBeLessThanOrEqual(DEFAULT_POLICY.explore);
  });
});
