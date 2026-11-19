import type { QueryKey } from "@tanstack/react-query";
import { CHAT_EVENT_TEXT } from "@repo/domain/activity";
import type { ActivityEvent, ActivityKind } from "@repo/domain/activity";
import type { Employee, RestingRunners, Speaker, TeamMessage } from "@repo/domain/domain";
import { orpc } from "@/renderer/api";

type Slice =
  | "company"
  | "employees"
  | "resting"
  | "products"
  | "bets"
  | "tasks"
  | "room"
  | "stripeKey"
  | "all";

const SLICE_KEYS = {
  all: [
    orpc.agents.resting.key(),
    orpc.bets.key(),
    orpc.company.key(),
    orpc.employees.key(),
    orpc.products.key(),
    orpc.save.key(),
    orpc.tasks.key(),
    orpc.team.key(),
  ],
  bets: [orpc.bets.key()],
  company: [orpc.company.key()],
  employees: [orpc.employees.list.key()],
  products: [orpc.products.key()],
  resting: [orpc.agents.resting.key()],
  room: [orpc.team.key()],
  stripeKey: [orpc.stripe.keyStatus.key()],
  tasks: [orpc.tasks.key(), orpc.employees.options.key()],
} satisfies Record<Slice, readonly QueryKey[]>;

/** Everything main's events can move: what the page asks for again once it may have missed some. */
export const EVERYTHING: readonly QueryKey[] = [
  ...SLICE_KEYS.all,
  ...SLICE_KEYS.stripeKey,
  orpc.agents.hasAuth.key(),
  orpc.app.update.key(),
];

const ACTIVITY_RING = 300;

/** News #team shows that only the live stream carries; the room keeps no copy of it. */
type News = Extract<
  ActivityEvent,
  { kind: "ship" | "org.hired" | "org.released" | "runner.resting" | "run.ask" }
>;

/**
 * A line of #team. It keeps its own lines: tool calls fill the ring and would evict them. A
 * room line is the room's own, named by its id, so the one read back when a window opens and
 * the one its event brings are the same line.
 */
export type FeedLine =
  | { kind: "room"; id: number; createdAt: number; from: Speaker; text: string }
  | { kind: "news"; event: News };

export const FEED_LINES = 30;

const feedLineOf = (e: ActivityEvent) => {
  switch (e.kind) {
    case "chat": {
      const { from, line } = e.payload;

      return {
        createdAt: e.createdAt,
        from,
        id: line,
        kind: "room",
        text: e.message,
      } satisfies FeedLine | null;
    }

    case "ship":
    case "org.hired":
    case "org.released":
    case "runner.resting":
    case "run.ask": {
      return { event: e, kind: "news" } satisfies FeedLine | null;
    }

    default: {
      return null;
    }
  }
};

/** Names a feed line across both kinds: what the feed dedupes by, and React's key. */
export const feedKey = (line: FeedLine) =>
  line.kind === "room" ? `room ${line.id}` : `news ${line.event.id}`;

const whenOf = (line: FeedLine) => (line.kind === "room" ? line.createdAt : line.event.createdAt);

/** When the feed's newest line was said, or null while it has none. */
export const newestOf = (feed: readonly FeedLine[]) => {
  const last = feed.at(-1);

  return last ? whenOf(last) : null;
};

/** The room as main keeps it, as feed lines, each cut as its event is. */
export const roomLines = (messages: readonly TeamMessage[]) =>
  messages.map<FeedLine>(({ createdAt, from, id, text }) => ({
    createdAt,
    from,
    id,
    kind: "room",
    text: text.slice(0, CHAT_EVENT_TEXT),
  }));

/** The feed with `lines` it lacks, in the order they were said, to its last FEED_LINES. */
export const joinFeed = (feed: readonly FeedLine[], lines: readonly FeedLine[]) => {
  const held = new Set(feed.map(feedKey));
  const fresh = lines.filter((line) => !held.has(feedKey(line)));

  return [...feed, ...fresh].toSorted((a, b) => whenOf(a) - whenOf(b)).slice(-FEED_LINES);
};

interface Heard {
  activity: readonly ActivityEvent[];
  feed: readonly FeedLine[];
}

export interface ActivityStep {
  /** The ring and #team with the event in them. */
  heard: { activity: ActivityEvent[]; feed?: FeedLine[] };
  /** Main's answers the event moved in place: each newer than any answer still in flight. */
  patch: {
    employees?: (held: Employee[]) => Employee[];
    resting?: (held: RestingRunners) => RestingRunners;
  };
  /** What to ask main for again, a patched answer among it: its cancelled read carried more. */
  refetch: readonly QueryKey[];
  /** Someone joined or left: the office walks them through the door once the roster is fresh. */
  roster: { employeeId: string; hired: boolean } | null;
  /** A run found its runner signed out, so main may have no signed-in CLI left. */
  recheckAuth: boolean;
}

const REFETCH_FOR = {
  "autopilot.changed": ["company"],
  "bet.changed": ["bets", "tasks"],
  "budget.exhausted": ["company"],
  chat: ["room"],
  message: [],
  "metrics.pulse": ["company", "products", "bets", "stripeKey"],
  "order.card": ["tasks"],
  "org.hired": ["all"],
  "org.released": ["all"],
  "product.created": ["products"],
  "product.killed": ["products", "bets", "tasks"],
  "product.named": ["products"],
  "run.ask": ["tasks"],
  "run.end": ["all"],
  "run.start": ["employees"],
  "runner.resting": ["resting"],
  ship: [],
  status: ["tasks"],
  "task.dead": ["tasks"],
  "task.retry": [],
  tool_call: [],
} satisfies Record<ActivityKind, readonly Slice[]>;

export const reduceActivity = (heard: Heard, e: ActivityEvent) => {
  const ring = heard.activity;
  const activity = ring.length >= ACTIVITY_RING ? [...ring.slice(1), e] : [...ring, e];

  const step: ActivityStep = {
    heard: { activity },
    patch: {},
    recheckAuth: e.kind === "run.end" && e.payload.outcome.kind === "signedOut",
    refetch: REFETCH_FOR[e.kind].flatMap((slice: Slice) => SLICE_KEYS[slice]),
    roster: null,
  };

  const line = feedLineOf(e);

  if (line) {
    step.heard.feed = joinFeed(heard.feed, [line]);
  }

  if (e.kind === "run.start" || e.kind === "run.end") {
    const status = e.kind === "run.start" ? "working" : "idle";
    step.patch.employees = (held) =>
      held.map((emp) => (emp.id === e.employeeId ? { ...emp, status } : emp));
  }

  if (e.kind === "runner.resting") {
    step.patch.resting = (held) => ({ ...held, [e.payload.runner]: e.payload.until });
  }

  if (e.kind === "org.hired" || e.kind === "org.released") {
    step.roster = { employeeId: e.employeeId, hired: e.kind === "org.hired" };
  }

  return step;
};
