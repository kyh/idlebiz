import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  KILL_GRACE_MS,
  allocate,
  claimsCollide,
  dream,
  hasRoomFor,
  holdsItsPath,
  judge,
  namedPathRefusal,
} from "@/shared/bets";
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
  readAt: null,
  reading: null,
  spentUsd: 0,
  state: { kind: "open" },
  target: 50,
  title: "Launch post",
  windowHours: 24,
  ...patch,
});

const verdict = (moved: number, closedAt: number): BetState =>
  moved >= 50
    ? { closedAt, kind: "won", moved }
    : { closedAt, kind: "killed", moved, reason: "short" };

const closed = (id: string, productId: string, at: number, moved: number, spentUsd = 1): Bet =>
  bet({ createdAt: at, id, productId, spentUsd, state: verdict(moved, at + HOUR) });

/** Killed before any source reported its number. */
const unread = (id: string, productId: string, at: number): Bet =>
  bet({
    createdAt: at,
    id,
    productId,
    spentUsd: 1,
    state: { closedAt: at + HOUR, kind: "killed", moved: null, reason: "never read" },
  });

const ledger = (bets: Bet[], products = ["app", "site"]) => ({
  bets,
  busy: new Map<string, number>(),
  products,
  proposalPending: false,
  runCostUsd: 1,
  stalled: new Set<string>(),
});

const measuring: BetState = { kind: "measuring", until: 10 };
/** One more window after `measuring` closed: how long a verdict waits on a fresh reading. */
const CLOSES_AGAIN = 10 + 24 * HOUR;
const ASKING_ALL_ALONG = 0;

describe("judge", () => {
  it("leaves an open bet alone while it has budget and no result", () => {
    expect(judge(bet({ reading: 20 }), 0, ASKING_ALL_ALONG)).toEqual({ kind: "open" });
  });

  it("wins the moment what it claims reaches the target", () => {
    expect(judge(bet({ reading: 50 }), 7, ASKING_ALL_ALONG)).toEqual({
      closedAt: 7,
      kind: "won",
      moved: 50,
    });
  });

  it("does not start the clock just because the budget is spent", () => {
    expect(judge(bet({ reading: 20, spentUsd: 5 }), 0, ASKING_ALL_ALONG)).toEqual({ kind: "open" });
  });

  it("kills a bet whose window closed short", () => {
    expect(judge(bet({ readAt: 10, reading: 20, state: measuring }), 10, null)).toMatchObject({
      kind: "killed",
      moved: 20,
      reason: "it brought 20 of 50 users",
    });
  });

  it("kills nothing on a reading taken before its window closed", () => {
    const stale = bet({ readAt: 9, reading: 20, state: measuring });
    expect(judge(stale, 10, ASKING_ALL_ALONG)).toBe(measuring);
    expect(judge(stale, CLOSES_AGAIN - 1, ASKING_ALL_ALONG)).toBe(measuring);
  });

  it("wins on the first reading after the window closed, if it reached the target", () => {
    expect(judge(bet({ readAt: 12, reading: 50, state: measuring }), 13, null)).toEqual({
      closedAt: 13,
      kind: "won",
      moved: 50,
    });
  });

  it("kills on the last reading once a second window passed without a fresh one, naming the source", () => {
    expect(
      judge(bet({ readAt: 9, reading: 20, state: measuring }), CLOSES_AGAIN, ASKING_ALL_ALONG),
    ).toMatchObject({
      kind: "killed",
      moved: 20,
      reason: "Vercel sent no reading in the 24h after its window closed",
    });
  });

  it("calls a source dead only once the pulse has asked it through the grace", () => {
    const stale = bet({ readAt: 9, reading: 20, state: measuring });
    const wokeAt = CLOSES_AGAIN + 5 * HOUR;
    expect(judge(stale, wokeAt, null)).toBe(measuring);
    expect(judge(stale, wokeAt, wokeAt)).toBe(measuring);
    expect(judge(stale, wokeAt + KILL_GRACE_MS - 1, wokeAt)).toBe(measuring);
    expect(judge(stale, wokeAt + KILL_GRACE_MS, wokeAt)).toMatchObject({ kind: "killed" });
  });

  it("kills a bet nothing could ever measure, naming the source that never answered", () => {
    const visits = bet({ state: measuring });
    const money = bet({ claim: { metric: "revenue" }, state: measuring });
    expect(judge(visits, CLOSES_AGAIN - 1, ASKING_ALL_ALONG)).toBe(measuring);
    expect(judge(visits, CLOSES_AGAIN, ASKING_ALL_ALONG)).toMatchObject({
      kind: "killed",
      moved: null,
      reason: "Vercel never reported its users",
    });
    expect(judge(money, CLOSES_AGAIN, ASKING_ALL_ALONG)).toMatchObject({
      moved: null,
      reason: "Stripe never reported its revenue",
    });
  });

  it("never reopens a verdict", () => {
    const won: BetState = { closedAt: 1, kind: "won", moved: 50 };
    expect(judge(bet({ state: won }), 99, ASKING_ALL_ALONG)).toBe(won);
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

describe("namedPathRefusal", () => {
  it("refuses the whole site and every /b/ path, which get visitors no new bet brought", () => {
    for (const path of ["/", "//", "/b", "/b/", "/b/launch", "/b/launch/deep"]) {
      expect(namedPathRefusal(path)).toContain(`${path} would count visitors`);
    }
  });

  it("lets a bet name a section of its own", () => {
    expect(namedPathRefusal("/guides")).toBeNull();
    expect(namedPathRefusal("/blog")).toBeNull();
  });
});

describe("holdsItsPath", () => {
  const killed: BetState = { closedAt: 1, kind: "killed", moved: 0, reason: "dud" };

  it("holds every live bet's path, and a section a closed bet named", () => {
    expect(holdsItsPath(landing("a", "/"))).toBe(true);
    expect(holdsItsPath(landing("a", "/b/a"))).toBe(true);
    expect(holdsItsPath({ ...landing("a", "/guides"), state: killed })).toBe(true);
  });

  it("frees a closed bet's /b/ path, and a whole-site claim from before bets owned paths", () => {
    expect(holdsItsPath({ ...landing("a", "/b/a"), state: killed })).toBe(false);
    expect(holdsItsPath({ ...landing("a", "/"), state: killed })).toBe(false);
    expect(holdsItsPath(bet({ claim: { metric: "revenue" }, state: killed }))).toBe(false);
  });
});

describe("hasRoomFor", () => {
  it("counts runs in flight against the budget before they bill", () => {
    const halfSpent = bet({ budgetUsd: 3, spentUsd: 1.5 });
    expect(hasRoomFor(halfSpent, 1, 1)).toBe(true);
    expect(hasRoomFor(halfSpent, 2, 1)).toBe(false);
    expect(hasRoomFor(halfSpent, 2, 0)).toBe(true);
  });

  it("has none once the budget is spent, or the bet has stopped taking work", () => {
    expect(hasRoomFor(bet({ spentUsd: 5 }), 0, 1)).toBe(false);
    expect(hasRoomFor(bet({ state: measuring }), 0, 1)).toBe(false);
    expect(hasRoomFor(bet({ state: verdict(60, 1) }), 0, 1)).toBe(false);
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

  it("counts no bet a source never read toward a run of losses", () => {
    const losses = [
      closed("l0", "app", 0, 0),
      closed("l1", "app", HOUR, 0),
      unread("u", "app", 2 * HOUR),
    ];
    expect(allocate(ledger(losses), DEFAULT_POLICY)).toMatchObject({
      kind: "propose",
      widen: false,
    });
  });

  it("scores a product only by what its bets were read to bring", () => {
    const pick = allocate(
      ledger([
        closed("a", "app", 0, 100),
        unread("u1", "app", 0),
        unread("u2", "app", 0),
        closed("s", "site", 0, 50),
        bet({ id: "app-next", productId: "app" }),
        bet({ id: "site-next", productId: "site" }),
      ]),
      { explore: 0, plateau: 3 },
    );
    expect(pick).toEqual({ betId: "app-next", kind: "work" });
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

  // ten verdicts on which a bolder explore replays better than the incumbent's
  const early = ["e0", "e1", "e2", "e3"].map((id, i) => closed(id, "app", i * HOUR, 40));
  const late = ["app", "app", "app", "site", "site", "site"].map((productId, i) =>
    bet({
      createdAt: 10 * HOUR + i,
      id: `l${i}`,
      productId,
      spentUsd: 1,
      state: verdict(productId === "site" ? 100 : 10, 20 * HOUR),
    }),
  );

  it("keeps the incumbent plateau", () => {
    expect(dream({ explore: 1, plateau: 5 }, [...early, ...late])).toEqual({
      explore: 2,
      plateau: 5,
    });
  });

  it("counts no bet a source never read toward the history it needs", () => {
    const unreadApp = late.map((b) =>
      b.productId === "app" ? unread(b.id, "app", b.createdAt) : b,
    );
    expect(dream({ explore: 1, plateau: 5 }, [...early, ...unreadApp])).toEqual({
      explore: 1,
      plateau: 5,
    });
  });

  it("leaves a bet no source ever read out of the replay", () => {
    expect(
      dream({ explore: 1, plateau: 5 }, [unread("u", "site", 10 * HOUR - 1), ...early, ...late]),
    ).toEqual({
      explore: 2,
      plateau: 5,
    });
  });

  it("a free win cannot pick the policy", () => {
    const history: [productId: string, closesAtHour: number, moved: number][] = [
      ["site", 2, 0],
      ["site", 4, 100],
      ["site", 4, 0],
      ["app", 6, 100],
      ["site", 6, 0],
      ["site", 7, 0],
      ["app", 7, 100],
      ["site", 8, 0],
    ];
    const withB1At = (spentUsd: number): Bet[] =>
      history.map(([productId, closesAtHour, moved], i) =>
        bet({
          createdAt: i * HOUR,
          id: `b${i}`,
          productId,
          spentUsd: i === 1 ? spentUsd : 2,
          state: verdict(moved, closesAtHour * HOUR),
        }),
      );
    expect(dream(DEFAULT_POLICY, withB1At(0))).toEqual(dream(DEFAULT_POLICY, withB1At(1)));
  });
});
