import { z } from "zod";

// A bet is the unit the company is steered by: a hypothesis about one real
// number of one product, a spend cap, and a window to be proven in. Everything
// here is pure so the scheduler, the evaluator and the replay judge one way.

export const BET_METRICS = ["users", "revenue"] as const;
export type BetMetric = (typeof BET_METRICS)[number];

export const BetStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open") }),
  z.object({ kind: z.literal("measuring"), until: z.number() }),
  z.object({ closedAt: z.number(), kind: z.literal("won"), moved: z.number() }),
  z.object({
    closedAt: z.number(),
    kind: z.literal("killed"),
    // null when no source ever reported the metric
    moved: z.number().nullable(),
    reason: z.string(),
  }),
]);
export type BetState = z.infer<typeof BetStateSchema>;

export interface Bet {
  id: string;
  companyId: string;
  productId: string;
  title: string;
  hypothesis: string;
  metric: BetMetric;
  /** How far the metric must move from `baseline` for the bet to win. */
  target: number;
  /** Where the metric stood when the bet opened; an unconnected source reads as zero. */
  baseline: number;
  budgetUsd: number;
  spentUsd: number;
  /** How long the metric gets to respond once the work stops. */
  windowHours: number;
  state: BetState;
  createdAt: number;
}

export type ClosedBet = Bet & { state: Extract<BetState, { kind: "won" | "killed" }> };

export const isClosed = (bet: Bet): bet is ClosedBet =>
  bet.state.kind === "won" || bet.state.kind === "killed";

/** Open with budget left: the only bets work may be spent on. */
export const isFundable = (bet: Bet): boolean =>
  bet.state.kind === "open" && bet.spentUsd < bet.budgetUsd;

const HOUR_MS = 3_600_000;

/**
 * The verdict is the evaluator's, never the team's: a bet wins when the real
 * number moved by its target, and dies when its window closes short of it.
 * `reading` is null while no source reports the metric.
 */
export const judge = (bet: Bet, reading: number | null, now: number): BetState => {
  const { state } = bet;
  if (state.kind === "won" || state.kind === "killed") {
    return state;
  }
  const moved = reading === null ? null : reading - bet.baseline;
  if (moved !== null && moved >= bet.target) {
    return { closedAt: now, kind: "won", moved };
  }
  if (state.kind === "open") {
    return bet.spentUsd >= bet.budgetUsd
      ? { kind: "measuring", until: now + bet.windowHours * HOUR_MS }
      : state;
  }
  if (now < state.until) {
    return state;
  }
  return {
    closedAt: now,
    kind: "killed",
    moved,
    reason:
      moved === null
        ? `no source ever reported ${bet.metric}`
        : `${bet.metric} moved ${moved} of the ${bet.target} it needed`,
  };
};

/** What a closed bet returned against what it promised, capped so one outlier cannot own the mean. */
const yieldOf = (bet: ClosedBet): number =>
  Math.min(2, Math.max(0, (bet.state.moved ?? 0) / Math.max(bet.target, 1)));

export const PolicyParamsSchema = z.object({
  /** Weight of the bonus for products with little history. */
  explore: z.number(),
  /** This many straight losses reads as a plateau. */
  plateau: z.number().int().positive(),
});
export type PolicyParams = z.infer<typeof PolicyParamsSchema>;

export const DEFAULT_POLICY: PolicyParams = { explore: 1, plateau: 3 };

export type Allocation =
  | { kind: "work"; betId: string }
  /** Nothing fundable: the lead opens a bet. `widen` asks for new ground, `productId` names the best proven one. */
  | { kind: "propose"; productId: string | null; widen: boolean }
  /** Every number is already being bet on and the portfolio is full: spend nothing until a verdict. */
  | { kind: "wait" };

/** Past this many live products a new one has to replace a killed one. */
const MAX_LIVE_PRODUCTS = 5;

export interface Ledger {
  bets: readonly Bet[];
  /** Products still alive, by id. */
  products: readonly string[];
  /** Runs already in flight per bet, so idle hands spread out. */
  busy: ReadonlyMap<string, number>;
}

/** Mean yield of a product's closed bets plus a bonus that shrinks as its history grows. */
const productScore = (productId: string, closed: readonly ClosedBet[], explore: number): number => {
  const own = closed.filter((b) => b.productId === productId);
  const mean = own.length === 0 ? 0 : own.reduce((sum, b) => sum + yieldOf(b), 0) / own.length;
  return mean + explore * Math.sqrt(Math.log(closed.length + 2) / (own.length + 1));
};

const CROWDING = 0.5;

/** Where the next idle hour goes. Pure, so a candidate policy can be replayed against history. */
export const allocate = (ledger: Ledger, params: PolicyParams): Allocation => {
  const closed = ledger.bets
    .filter(isClosed)
    .toSorted((a, b) => a.state.closedAt - b.state.closedAt);
  const score = (productId: string): number => productScore(productId, closed, params.explore);
  const live = new Set(ledger.products);
  const fundable = ledger.bets.filter((b) => isFundable(b) && live.has(b.productId));
  const [best] = fundable.toSorted(
    (a, b) =>
      score(b.productId) -
      CROWDING * (ledger.busy.get(b.id) ?? 0) -
      (score(a.productId) - CROWDING * (ledger.busy.get(a.id) ?? 0)),
  );
  if (best) {
    return { betId: best.id, kind: "work" };
  }
  const recent = closed.slice(-params.plateau);
  const widen = recent.length >= params.plateau && recent.every((b) => b.state.kind === "killed");
  const liveBets = ledger.bets.filter((b) => !isClosed(b));
  // a product has room while one of its numbers has no live bet on it
  const [proven] = ledger.products
    .filter((id) => liveBets.filter((b) => b.productId === id).length < BET_METRICS.length)
    .toSorted((a, b) => score(b) - score(a));
  if (proven === undefined && ledger.products.length >= MAX_LIVE_PRODUCTS) {
    return { kind: "wait" };
  }
  return { kind: "propose", productId: proven ?? null, widen: widen || proven === undefined };
};

/** History shorter than this says too little to retune on. */
const MIN_BETS_TO_DREAM = 8;

const CANDIDATES: readonly PolicyParams[] = [0, 0.5, 1, 2].flatMap((explore) =>
  [2, 3, 5].map((plateau) => ({ explore, plateau })),
);

/**
 * Replay a policy against the company's closed bets: at each moment a bet opened,
 * the policy picks among the bets that really were open then, knowing only what
 * had closed by then, and earns the yield per dollar its pick really returned.
 * Exact over what happened, silent about what did not.
 */
const replayScore = (params: PolicyParams, bets: readonly ClosedBet[]): number => {
  let earned = 0;
  let picks = 0;
  for (const opening of bets) {
    const at = opening.createdAt;
    const known = bets.filter((b) => b.state.closedAt <= at);
    const available = bets.filter((b) => b.createdAt <= at && b.state.closedAt > at);
    const choice = allocate(
      {
        bets: [
          ...known,
          ...available.map((b): Bet => ({ ...b, spentUsd: 0, state: { kind: "open" } })),
        ],
        busy: new Map(),
        products: [...new Set(bets.map((b) => b.productId))],
      },
      params,
    );
    const picked =
      choice.kind === "work" ? available.find((b) => b.id === choice.betId) : undefined;
    if (picked) {
      earned += yieldOf(picked) / Math.max(picked.spentUsd, 0.01);
      picks += 1;
    }
  }
  return picks === 0 ? 0 : earned / picks;
};

/** The best-replaying policy. The incumbent is a candidate and wins ties, so a swap is never a step down. */
export const dream = (incumbent: PolicyParams, bets: readonly Bet[]): PolicyParams => {
  const closed = bets.filter(isClosed);
  if (closed.length < MIN_BETS_TO_DREAM) {
    return incumbent;
  }
  let best = incumbent;
  let bestScore = replayScore(incumbent, closed);
  for (const candidate of CANDIDATES) {
    const candidateScore = replayScore(candidate, closed);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
};
