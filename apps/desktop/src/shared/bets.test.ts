import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, allocate, dream, judge } from "@/shared/bets";
import type { Bet, BetState } from "@/shared/bets";

const HOUR = 3_600_000;

const bet = (patch: Partial<Bet> = {}): Bet => ({
  baseline: 10,
  budgetUsd: 5,
  companyId: "co",
  createdAt: 0,
  hypothesis: "a launch post brings visitors",
  id: "bet",
  metric: "users",
  productId: "app",
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
});

describe("judge", () => {
  it("leaves an open bet alone while it has budget and no result", () => {
    expect(judge(bet(), 20, 0)).toEqual({ kind: "open" });
  });

  it("wins the moment the real number has moved by the target", () => {
    expect(judge(bet(), 60, 7)).toEqual({ closedAt: 7, kind: "won", moved: 50 });
  });

  it("starts the clock when the budget is spent", () => {
    expect(judge(bet({ spentUsd: 5 }), 20, 0)).toEqual({ kind: "measuring", until: 24 * HOUR });
  });

  it("kills a bet whose window closed short", () => {
    const state = judge(bet({ state: { kind: "measuring", until: 10 } }), 30, 10);
    expect(state).toMatchObject({ kind: "killed", moved: 20 });
  });

  it("kills a bet nothing could ever measure", () => {
    const state = judge(bet({ state: { kind: "measuring", until: 10 } }), null, 10);
    expect(state).toMatchObject({ kind: "killed", moved: null });
  });

  it("never reopens a verdict", () => {
    const won: BetState = { closedAt: 1, kind: "won", moved: 50 };
    expect(judge(bet({ state: won }), 0, 99)).toBe(won);
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

  it("asks for a new product when every number is already bet on", () => {
    const full = [
      bet({ id: "u", spentUsd: 5 }),
      bet({ id: "r", metric: "revenue", state: { kind: "measuring", until: 9 } }),
    ];
    expect(allocate(ledger(full, ["app"]), DEFAULT_POLICY)).toEqual({
      kind: "propose",
      productId: null,
      widen: true,
    });
  });

  it("waits when the portfolio is full and every number is bet on", () => {
    const products = ["a", "b", "c", "d", "e"];
    const full = products.flatMap((productId) => [
      bet({ id: `${productId}-u`, productId, spentUsd: 5 }),
      bet({ id: `${productId}-r`, metric: "revenue", productId, spentUsd: 5 }),
    ]);
    expect(allocate(ledger(full, products), DEFAULT_POLICY)).toEqual({ kind: "wait" });
  });
});

describe("dream", () => {
  it("keeps the incumbent on thin history", () => {
    expect(dream(DEFAULT_POLICY, [[closed("a", "app", 0, 100)]])).toBe(DEFAULT_POLICY);
  });

  it("never swaps to a policy that replays worse", () => {
    const history = Array.from({ length: 10 }, (_, i) =>
      closed(`b${i}`, i % 2 === 0 ? "app" : "site", i * (HOUR / 2), i % 2 === 0 ? 100 : 0),
    );
    const next = dream(DEFAULT_POLICY, [history]);
    expect(next.explore).toBeLessThanOrEqual(DEFAULT_POLICY.explore);
  });
});
