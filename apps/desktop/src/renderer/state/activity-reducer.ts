import type { QueryKey } from "@tanstack/react-query";
import { CHAT_EVENT_TEXT } from "@repo/domain/activity";
import type { ActivityEvent, ActivityKind } from "@repo/domain/activity";
import type { Employee, RestingRunners, Speaker, TeamMessage } from "@repo/domain/domain";
import { orpc } from "@/renderer/api";

// What an event from main means for the page's copy of main's state, with no fetch and no
// Phaser in sight: what the window heard, a patch to main's answers it can apply at once, and the
// keys of the answers to ask main for again. Main's store is the truth; events only say which part
// of it moved.

/** A part of main's state the page holds a copy of. */
type Slice = "company" | "employees" | "resting" | "products" | "bets" | "tasks" | "room" | "all";

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
  // each product's status with the list
  products: [orpc.products.key()],
  resting: [orpc.agents.resting.key()],
  room: [orpc.team.key()],
  // what an employee can be asked comes from their open work
  tasks: [orpc.tasks.key(), orpc.employees.options.key()],
} satisfies Record<Slice, readonly QueryKey[]>;

/** Everything main's events can move: what the page asks for again once it may have missed some. */
export const EVERYTHING: readonly QueryKey[] = [
  ...SLICE_KEYS.all,
  orpc.agents.hasAuth.key(),
  orpc.stripe.status.key(),
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

const feedLineOf = (e: ActivityEvent): FeedLine | null => {
  switch (e.kind) {
    case "chat": {
      const { from, line } = e.payload;
      return { createdAt: e.createdAt, from, id: line, kind: "room", text: e.message };
    }
    case "ship":
    case "org.hired":
    case "org.released":
    case "runner.resting":
    case "run.ask": {
      return { event: e, kind: "news" };
    }
    default: {
      return null;
    }
  }
};

/** Names a feed line across both kinds: what the feed dedupes by, and React's key. */
export const feedKey = (line: FeedLine): string =>
  line.kind === "room" ? `room ${line.id}` : `news ${line.event.id}`;

const whenOf = (line: FeedLine): number =>
  line.kind === "room" ? line.createdAt : line.event.createdAt;

/** When the feed's newest line was said, or null while it has none. */
export const newestOf = (feed: readonly FeedLine[]): number | null => {
  const last = feed.at(-1);
  return last ? whenOf(last) : null;
};

/** The room as main keeps it, as feed lines, each cut as its event is. */
export const roomLines = (messages: readonly TeamMessage[]): FeedLine[] =>
  messages.map(({ createdAt, from, id, text }) => ({
    createdAt,
    from,
    id,
    kind: "room",
    text: text.slice(0, CHAT_EVENT_TEXT),
  }));

/** The feed with `lines` it lacks, in the order they were said, to its last FEED_LINES. */
export const joinFeed = (feed: readonly FeedLine[], lines: readonly FeedLine[]): FeedLine[] => {
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

/** The slices each kind of event moves; a kind missing here is a compile error, not a silent default. */
const REFETCH_FOR = {
  "autopilot.changed": ["company"],
  "bet.changed": ["bets", "tasks"],
  "budget.exhausted": ["company"],
  // the team panel shows the room's lines in full, where the event cuts them
  chat: ["room"],
  message: [],
  // the pulse writes each product's numbers and each live bet's reading too
  "metrics.pulse": ["company", "products", "bets"],
  // an order card is a task no run touches, so its own event says it came or went
  "order.card": ["tasks"],
  "org.hired": ["all"],
  "org.released": ["all"],
  "product.created": ["products"],
  // retiring a product drops its waiting work
  "product.killed": ["products", "bets", "tasks"],
  "product.named": ["products"],
  // An ask exists the moment it is raised, and a dead letter the moment it dies.
  // Every way back out (answered, approved, retried, resumed on connect) goes
  // through the scheduler's assign, which says `status: queued`. The inbox must
  // not wait for the run to end to agree with the office.
  "run.ask": ["tasks"],
  "run.end": ["all"],
  // A patch outranks any answer for its slice still in flight, so the store
  // cancels that read, and whatever else it would have carried (a hire) with it.
  "run.start": ["employees"],
  "runner.resting": ["resting"],
  ship: [],
  status: ["tasks"],
  "task.dead": ["tasks"],
  "task.retry": [],
  tool_call: [],
} satisfies Record<ActivityKind, readonly Slice[]>;

export const reduceActivity = (heard: Heard, e: ActivityEvent): ActivityStep => {
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
  // A status names a task, not its assignee: queueing work for someone mid-run must not idle them.
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
