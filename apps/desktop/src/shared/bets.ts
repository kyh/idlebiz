import { z } from "zod";
import { formatUsd } from "@/shared/format";

// A bet is the unit the company is steered by: a hypothesis about one real
// number of one product, a spend cap, and a window to be proven in. It counts
// only what carries its mark — visitors who landed on its path, money tagged
// with its id — so any number of bets can run at once and none can claim
// another's result. Everything here is pure so the scheduler, the evaluator
// and the replay judge one way.

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

/** A path a users-bet may own: absolute, plain segments, no query. */
export const LandingPathSchema = z
  .string()
  .regex(/^\/[\w\-./]*$/u)
  .max(120);

/** What the bet counts. */
export const BetClaimSchema = z.discriminatedUnion("metric", [
  /** Visitors who landed under `landingPath` since the bet opened: every link the bet places points there. */
  z.object({ landingPath: LandingPathSchema, metric: z.literal("users") }),
  /** Money kept from Stripe charges tagged `metadata[bet]=<id>`. */
  z.object({ metric: z.literal("revenue") }),
]);
export type BetClaim = z.infer<typeof BetClaimSchema>;

/** Where a users-bet lands unless it names somewhere else: one rewrite rule on the product serves every bet. */
export const defaultLandingPath = (betId: string): string => `/b/${betId}`;

const segments = (path: string): string[] => path.split("/").filter((part) => part !== "");

/** One path sits under the other, so a visitor to the deeper one would count for both. */
const pathsOverlap = (a: string, b: string): boolean => {
  const [x, y] = [segments(a), segments(b)];
  return x.slice(0, y.length).join("/") === y.slice(0, x.length).join("/");
};

/** Two bets that would count the same visitors. Money is tagged per bet, so revenue claims never collide. */
export const claimsCollide = (a: Bet, b: Bet): boolean =>
  a.productId === b.productId &&
  a.claim.metric === "users" &&
  b.claim.metric === "users" &&
  pathsOverlap(a.claim.landingPath, b.claim.landingPath);

export interface Bet {
  id: string;
  companyId: string;
  productId: string;
  title: string;
  hypothesis: string;
  claim: BetClaim;
  /** How much of what it claims the bet must bring in to win. */
  target: number;
  /** What it has brought in so far, as the last pulse read it; null while no source reports it. */
  reading: number | null;
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

/** Open with the budget gone: no more work, and the lead owes it a call — start the clock or kill it. */
export const isSpentOut = (bet: Bet): boolean =>
  bet.state.kind === "open" && bet.spentUsd >= bet.budgetUsd;

const HOUR_MS = 3_600_000;

/** When a window started now would close. */
export const windowEnd = (bet: Bet, now: number): number => now + bet.windowHours * HOUR_MS;

/** "+50 users" / "+$20.00 revenue": what the bet has to move. */
export const betGoal = (bet: Bet): string =>
  bet.claim.metric === "revenue" ? `+${formatUsd(bet.target)} revenue` : `+${bet.target} users`;

/** "12 of 50" / "$4.00 of $20.00": how far along it is, or that nothing can say. */
export const betProgress = (bet: Bet): string => {
  if (bet.reading === null) {
    return "no reading yet";
  }
  return bet.claim.metric === "revenue"
    ? `${formatUsd(bet.reading)} of ${formatUsd(bet.target)}`
    : `${bet.reading} of ${bet.target}`;
};

/** "$1.42 of $3.00": what it has burned of what it may. */
export const betMoney = (bet: Bet): string =>
  `${formatUsd(bet.spentUsd)} of ${formatUsd(bet.budgetUsd)}`;

/** The ledger as anyone reads it: live bets first, then verdicts newest first, at most `verdicts` of them. */
export const ledgerOrder = (bets: readonly Bet[], verdicts = Infinity): Bet[] => [
  ...bets.filter((b) => !isClosed(b)),
  ...bets
    .filter(isClosed)
    .toSorted((a, b) => b.state.closedAt - a.state.closedAt)
    .slice(0, verdicts),
];

/**
 * The verdict is the evaluator's, never the team's: a bet wins when what it
 * claims reached its target, and dies when its window closes short of it.
 * Only the lead starts a window, by saying the work is out the door.
 */
export const judge = (bet: Bet, now: number): BetState => {
  const { state, reading: moved } = bet;
  if (state.kind === "won" || state.kind === "killed") {
    return state;
  }
  if (moved !== null && moved >= bet.target) {
    return { closedAt: now, kind: "won", moved };
  }
  // Spending the budget does not start the clock: the work that could move the
  // number may still be waiting on the founder, and a window that runs out before
  // anything shipped is a false verdict on the hypothesis.
  if (state.kind === "open" || now < state.until) {
    return state;
  }
  return {
    closedAt: now,
    kind: "killed",
    moved,
    reason:
      moved === null
        ? `no source ever reported its ${bet.claim.metric}`
        : `it brought ${betProgress(bet)} ${bet.claim.metric}`,
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
  /** A bet spent its budget: the lead starts its clock or kills it before anything new is opened. */
  | { kind: "settle"; betId: string }
  /** Nothing fundable: the lead opens a bet. `widen` asks for new ground, `productId` names the best proven one. */
  | { kind: "propose"; productId: string | null; widen: boolean }
  /** Nothing to spend on until a verdict or the founder: every product has all the live bets it can carry and the portfolio is full, or the lead's last proposal is waiting on them. */
  | { kind: "wait" };

/** Past this many live products a new one has to replace a killed one. */
const MAX_LIVE_PRODUCTS = 5;
/** Past this many live bets a product waits for a verdict: each one is a window the lead has to watch. */
const MAX_LIVE_BETS_PER_PRODUCT = 3;

export interface Ledger {
  bets: readonly Bet[];
  /** Products still alive, by id. */
  products: readonly string[];
  /** Runs already in flight per bet, so idle hands spread out. */
  busy: ReadonlyMap<string, number>;
  /** Bets with work waiting on the founder: more hands would only re-report the same blocker. */
  stalled: ReadonlySet<string>;
  /** What one more run is expected to cost, so runs in flight count against a budget before they bill. */
  runCostUsd: number;
  /** The lead's last call on what to open next is waiting on the founder: asking again would only repeat it. */
  proposalPending: boolean;
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
  const scores = new Map(
    ledger.products.map((id) => [id, productScore(id, closed, params.explore)]),
  );
  const busyOn = (bet: Bet): number => ledger.busy.get(bet.id) ?? 0;
  const rank = (bet: Bet): number => (scores.get(bet.productId) ?? 0) - CROWDING * busyOn(bet);
  // a bet on a retired product has no score, and nobody works for or settles a bet waiting on the founder
  const open = ledger.bets.filter(
    (b) => b.state.kind === "open" && scores.has(b.productId) && !ledger.stalled.has(b.id),
  );
  const [best] = open
    .filter((b) => b.spentUsd + busyOn(b) * ledger.runCostUsd < b.budgetUsd)
    .toSorted((a, b) => rank(b) - rank(a));
  if (best) {
    return { betId: best.id, kind: "work" };
  }
  const spentOut = open.find((b) => isSpentOut(b) && busyOn(b) === 0);
  if (spentOut) {
    return { betId: spentOut.id, kind: "settle" };
  }
  if (ledger.proposalPending) {
    return { kind: "wait" };
  }
  const recent = closed.slice(-params.plateau);
  const widen = recent.length >= params.plateau && recent.every((b) => b.state.kind === "killed");
  const liveBets = ledger.bets.filter((b) => !isClosed(b));
  const [proven] = ledger.products
    .filter((id) => liveBets.filter((b) => b.productId === id).length < MAX_LIVE_BETS_PER_PRODUCT)
    .toSorted((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  if (proven === undefined && ledger.products.length >= MAX_LIVE_PRODUCTS) {
    return { kind: "wait" };
  }
  return { kind: "propose", productId: proven ?? null, widen: widen || proven === undefined };
};

/** History shorter than this says too little to retune on. */
const MIN_BETS_TO_DREAM = 8;
/** The replay is quadratic in bets and runs on the main process; the latest verdicts are also the ones the policy should fit. */
const MAX_BETS_TO_DREAM = 100;

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
  const products = [...new Set(bets.map((b) => b.productId))];
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
        products,
        proposalPending: false,
        runCostUsd: 0,
        stalled: new Set(),
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
  const closed = bets
    .filter(isClosed)
    .toSorted((a, b) => a.state.closedAt - b.state.closedAt)
    .slice(-MAX_BETS_TO_DREAM);
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
