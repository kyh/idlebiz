import { z } from "zod";
import { formatUsd } from "./format";

export const BetStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open") }),
  z.object({ kind: z.literal("measuring"), until: z.number() }),
  z.object({ closedAt: z.number(), kind: z.literal("won"), moved: z.number() }),
  z.object({
    closedAt: z.number(),
    kind: z.literal("killed"),
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
  z.object({ landingPath: LandingPathSchema, metric: z.literal("users") }),
  z.object({ metric: z.literal("revenue") }),
]);

export type BetClaim = z.infer<typeof BetClaimSchema>;

/** Where a users-bet lands unless it names somewhere else: one rewrite rule on the product serves every bet. */
export const defaultLandingPath = (betId: string) => `/b/${betId}`;

const segments = (path: string) => path.split("/").filter((part) => part !== "");

const pathsOverlap = (a: string, b: string) => {
  const [x, y] = [segments(a), segments(b)];

  return x.slice(0, y.length).join("/") === y.slice(0, x.length).join("/");
};

/** Why a users bet may not name `path`, or null when it may: the whole site and the /b/ paths get visitors no new bet brought. */
export const namedPathRefusal = (path: string) =>
  pathsOverlap(path, "/b")
    ? `${path} would count visitors this bet did not bring (the whole site, or another bet's /b/ path). Name a new section, or leave landingPath out to get /b/<slug>.`
    : null;

/** Two bets that would count the same visitors. Money is tagged per bet, so revenue claims never collide. */
export const claimsCollide = (a: Bet, b: Bet) =>
  a.productId === b.productId &&
  a.claim.metric === "users" &&
  b.claim.metric === "users" &&
  pathsOverlap(a.claim.landingPath, b.claim.landingPath);

export interface Bet {
  id: string;
  productId: string;
  title: string;
  hypothesis: string;
  claim: BetClaim;
  /** How much of what it claims the bet must bring in to win. */
  target: number;
  /** What it has brought in so far — by its window's close, once measuring — as the last pulse read it; null while no source reports it. */
  reading: number | null;
  /** When `reading` was taken: stamped when it moves, and by the first read after its window closed. */
  readAt: number | null;
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

/**
 * Whether a new bet must keep off this one's path. A live bet holds it; so does
 * a closed one that named a section, since its links keep sending visitors
 * there. A closed /b/ path is never handed out again, so nothing need keep off it.
 */
export const holdsItsPath = (bet: Bet) =>
  !isClosed(bet) ||
  (bet.claim.metric === "users" && namedPathRefusal(bet.claim.landingPath) === null);

/** Open, with budget left once the runs already in flight bill: the only bets one more run may be spent on. */
export const hasRoomFor = (bet: Bet, inFlight: number, runCostUsd: number) =>
  bet.state.kind === "open" && bet.spentUsd + inFlight * runCostUsd < bet.budgetUsd;

/** Open with the budget gone: no more work, and the lead owes it a call — start the clock or kill it. */
export const isSpentOut = (bet: Bet) => bet.state.kind === "open" && bet.spentUsd >= bet.budgetUsd;

const HOUR_MS = 3_600_000;

/** When a window started now would close. */
export const windowEnd = (bet: Bet, now: number) => now + bet.windowHours * HOUR_MS;

/** "+50 users" / "+$20.00 revenue": what the bet has to move. */
export const betGoal = (bet: Bet) =>
  bet.claim.metric === "revenue" ? `+${formatUsd(bet.target)} revenue` : `+${bet.target} users`;

/** "12 of 50" / "$4.00 of $20.00": how far along it is, or that nothing can say. */
export const betProgress = (bet: Bet) => {
  if (bet.reading === null) {
    return "no reading yet";
  }

  return bet.claim.metric === "revenue"
    ? `${formatUsd(bet.reading)} of ${formatUsd(bet.target)}`
    : `${bet.reading} of ${bet.target}`;
};

/** "$1.42 of $3.00": what it has burned of what it may. */
export const betMoney = (bet: Bet) => `${formatUsd(bet.spentUsd)} of ${formatUsd(bet.budgetUsd)}`;

/** The ledger as anyone reads it: live bets first, then verdicts newest first, at most `verdicts` of them. */
export const ledgerOrder = (bets: readonly Bet[], verdicts = Infinity) =>
  [
    ...bets.filter((b) => !isClosed(b)),
    ...bets
      .filter(isClosed)
      .toSorted((a, b) => b.state.closedAt - a.state.closedAt)
      .slice(0, verdicts),
  ] satisfies Bet[];

/** How long the pulse must have asked without a break before a source that sent nothing counts as dead: at boot or on waking, nothing has asked it yet. */
export const KILL_GRACE_MS = 20 * 60_000;

const sourceOf = (claim: BetClaim) => (claim.metric === "revenue" ? "Stripe" : "Vercel");

/**
 * The verdict is the evaluator's, never the team's: a bet wins when what it
 * claims reached its target, and dies when its window closes short of it.
 * Only the lead starts a window, by saying the work is out the door.
 * `pulsingSince` is when the pulse began asking without a break, null while it
 * is not asking.
 */
export const judge = (bet: Bet, now: number, pulsingSince: number | null) => {
  const { state, reading: moved } = bet;

  if (state.kind === "won" || state.kind === "killed") {
    return state;
  }

  if (moved !== null && moved >= bet.target) {
    return { closedAt: now, kind: "won", moved } satisfies BetState;
  }

  if (state.kind === "open" || now < state.until) {
    return state;
  }

  if (bet.readAt !== null && bet.readAt >= state.until) {
    return {
      closedAt: now,
      kind: "killed",
      moved,
      reason: `it brought ${betProgress(bet)} ${bet.claim.metric}`,
    } satisfies BetState;
  }

  const waited = now >= windowEnd(bet, state.until);
  const asked = pulsingSince !== null && now >= pulsingSince + KILL_GRACE_MS;

  if (!waited || !asked) {
    return state;
  }

  const source = sourceOf(bet.claim);

  return {
    closedAt: now,
    kind: "killed",
    moved,
    reason:
      moved === null
        ? `${source} never reported its ${bet.claim.metric}`
        : `${source} sent no reading in the ${bet.windowHours}h after its window closed`,
  } satisfies BetState;
};

type MeasuredBet = ClosedBet & { state: { moved: number } };

const isMeasured = (bet: Bet): bet is MeasuredBet => isClosed(bet) && bet.state.moved !== null;

const yieldOf = (bet: MeasuredBet) =>
  Math.min(2, Math.max(0, bet.state.moved / Math.max(bet.target, 1)));

export const PolicyParamsSchema = z.object({
  /** Weight of the bonus for products with little history. */
  explore: z.number(),
});

export type PolicyParams = z.infer<typeof PolicyParamsSchema>;

export const DEFAULT_POLICY: PolicyParams = { explore: 1 };

const PLATEAU = 3;

type Allocation =
  | { kind: "work"; betId: string }
  | { kind: "settle"; betId: string }
  | { kind: "propose"; productId: string | null; widen: boolean; newProduct: boolean }
  | { kind: "wait" };

/** Past this many live products a new one has to replace a killed one. */
export const MAX_LIVE_PRODUCTS = 5;

/** Past this many live bets a product waits for a verdict: each one is a window the lead has to watch. */
export const MAX_LIVE_BETS_PER_PRODUCT = 3;

export const portfolioHasRoom = (liveProducts: number) => liveProducts < MAX_LIVE_PRODUCTS;

export const productHasRoom = (bets: readonly Bet[], productId: string) =>
  bets.filter((b) => !isClosed(b) && b.productId === productId).length < MAX_LIVE_BETS_PER_PRODUCT;

/** The smallest target a bet may set: below it the founder's own clicks or a single charge win it, and every win lifts its product's score and breaks a losing streak. */
export const MIN_BET_TARGET: Readonly<Record<BetClaim["metric"], number>> = {
  revenue: 5,
  users: 10,
};

/** A run bills only when it ends, so runs in flight are counted at what one has typically cost; without it three hands start on a $2 bet and land it at $5. */
export const RUN_COST_ESTIMATE_USD = 1;

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
  /** The lead's last call on what to open next ended lately with nothing new on the ledger since: the same brief would get the same answer. */
  proposalIdle: boolean;
}

const productScore = (productId: string, closed: readonly MeasuredBet[], explore: number) => {
  const own = closed.filter((b) => b.productId === productId);
  const mean = own.length === 0 ? 0 : own.reduce((sum, b) => sum + yieldOf(b), 0) / own.length;

  return mean + explore * Math.sqrt(Math.log(closed.length + 2) / (own.length + 1));
};

const CROWDING = 0.5;

/** Where the next idle hour goes. Pure, so a candidate policy can be replayed against history. */
export const allocate = (ledger: Ledger, params: PolicyParams) => {
  const closed = ledger.bets
    .filter(isMeasured)
    .toSorted((a, b) => a.state.closedAt - b.state.closedAt);

  const scores = new Map(
    ledger.products.map((id) => [id, productScore(id, closed, params.explore)]),
  );

  const busyOn = (bet: Bet) => ledger.busy.get(bet.id) ?? 0;
  const rank = (bet: Bet) => (scores.get(bet.productId) ?? 0) - CROWDING * busyOn(bet);

  const open = ledger.bets.filter(
    (b) => b.state.kind === "open" && scores.has(b.productId) && !ledger.stalled.has(b.id),
  );

  const [best] = open
    .filter((b) => hasRoomFor(b, busyOn(b), ledger.runCostUsd))
    .toSorted((a, b) => rank(b) - rank(a));

  if (best) {
    return { betId: best.id, kind: "work" } satisfies Allocation;
  }

  const spentOut = open.find((b) => isSpentOut(b) && busyOn(b) === 0);

  if (spentOut) {
    return { betId: spentOut.id, kind: "settle" } satisfies Allocation;
  }

  if (ledger.proposalPending || ledger.proposalIdle) {
    return { kind: "wait" } satisfies Allocation;
  }

  const recent = closed.slice(-PLATEAU);
  const widen = recent.length >= PLATEAU && recent.every((b) => b.state.kind === "killed");

  const [proven] = ledger.products
    .filter((id) => productHasRoom(ledger.bets, id))
    .toSorted((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));

  const newProduct = portfolioHasRoom(ledger.products.length);

  if (proven === undefined && !newProduct) {
    return { kind: "wait" } satisfies Allocation;
  }

  return {
    kind: "propose",
    newProduct,
    productId: proven ?? null,
    widen: widen || proven === undefined,
  } satisfies Allocation;
};

const MIN_BETS_TO_DREAM = 8;
const MAX_BETS_TO_DREAM = 100;

const EXPLORE_CANDIDATES: readonly number[] = [0, 0.5, 1, 2];

const replayScore = (params: PolicyParams, bets: readonly MeasuredBet[]) => {
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
          ...available.map((b) => ({ ...b, spentUsd: 0, state: { kind: "open" } }) satisfies Bet),
        ],
        busy: new Map(),
        products,
        proposalIdle: false,
        proposalPending: false,
        runCostUsd: 0,
        stalled: new Set(),
      },
      params,
    );

    const picked =
      choice.kind === "work" ? available.find((b) => b.id === choice.betId) : undefined;

    if (picked) {
      earned += yieldOf(picked) / Math.max(picked.spentUsd, RUN_COST_ESTIMATE_USD);
      picks += 1;
    }
  }

  return picks === 0 ? 0 : earned / picks;
};

/** The best-replaying policy. The incumbent is a candidate and wins ties, so a swap is never a step down. */
export const dream = (incumbent: PolicyParams, bets: readonly Bet[]) => {
  const closed = bets
    .filter(isMeasured)
    .toSorted((a, b) => a.state.closedAt - b.state.closedAt)
    .slice(-MAX_BETS_TO_DREAM);

  if (closed.length < MIN_BETS_TO_DREAM) {
    return incumbent;
  }

  let best = incumbent;
  let bestScore = replayScore(incumbent, closed);

  for (const explore of EXPLORE_CANDIDATES) {
    const candidate = { explore };
    const candidateScore = replayScore(candidate, closed);

    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }

  return best;
};
