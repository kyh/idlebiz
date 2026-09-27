import { CHAT_EVENT_TEXT } from "@/shared/activity";
import type { ActivityEvent, ActivityKind } from "@/shared/activity";
import type { Employee, RestingRunners, Speaker, TeamMessage } from "@/shared/domain";

// What an event from main means for the renderer's copy of main's state, with
// no bridge and no Phaser in sight: a patch it can apply at once, and the
// slices it has to fetch again. Main's store is the truth; events only say
// which part of it moved.

/** A part of main's state the renderer holds a copy of. */
export type Slice = "company" | "employees" | "resting" | "products" | "bets" | "tasks" | "all";

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

/** The id of the room's newest line in the feed, or null while it holds none. */
export const newestRoomLine = (feed: readonly FeedLine[]): number | null =>
  feed.findLast((line) => line.kind === "room")?.id ?? null;

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

interface Held {
  activity: readonly ActivityEvent[];
  feed: readonly FeedLine[];
  employees: readonly Employee[];
  resting: RestingRunners;
}

export interface ActivityStep {
  patch: {
    activity: ActivityEvent[];
    feed?: FeedLine[];
    employees?: Employee[];
    resting?: RestingRunners;
  };
  reload: readonly Slice[];
  /** Someone joined or left: the office walks them through the door once the roster is fresh. */
  roster: { employeeId: string; hired: boolean } | null;
  /** A run found its runner signed out, so main may have no signed-in CLI left. */
  recheckAuth: boolean;
}

/** The slices each kind of event moves; a kind missing here is a compile error, not a silent default. */
const RELOAD_FOR = {
  "autopilot.changed": ["company"],
  "bet.changed": ["bets", "tasks"],
  "budget.exhausted": ["company"],
  chat: [],
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
  // An ask exists the moment it is raised, and a dead letter the moment it dies.
  // Every way back out (answered, approved, retried, resumed on connect) goes
  // through the scheduler's assign, which says `status: queued`. The inbox must
  // not wait for the run to end to agree with the office.
  "run.ask": ["tasks"],
  "run.end": ["all"],
  // A patch outranks any answer for its slice still in flight, so the store
  // refuses that answer, and whatever else it carried (a hire) with it.
  "run.start": ["employees"],
  "runner.resting": ["resting"],
  ship: [],
  status: ["tasks"],
  "task.dead": ["tasks"],
  "task.retry": [],
  tool_call: [],
} satisfies Record<ActivityKind, readonly Slice[]>;

export const reduceActivity = (held: Held, e: ActivityEvent): ActivityStep => {
  const ring = held.activity;
  const activity = ring.length >= ACTIVITY_RING ? [...ring.slice(1), e] : [...ring, e];
  const step: ActivityStep = {
    patch: { activity },
    recheckAuth: e.kind === "run.end" && e.payload.outcome.kind === "signedOut",
    reload: RELOAD_FOR[e.kind],
    roster: null,
  };
  const line = feedLineOf(e);
  if (line) {
    step.patch.feed = joinFeed(held.feed, [line]);
  }
  // A status names a task, not its assignee: queueing work for someone mid-run must not idle them.
  if (e.kind === "run.start" || e.kind === "run.end") {
    const status = e.kind === "run.start" ? "working" : "idle";
    step.patch.employees = held.employees.map((emp) =>
      emp.id === e.employeeId ? { ...emp, status } : emp,
    );
  }
  if (e.kind === "runner.resting") {
    step.patch.resting = { ...held.resting, [e.payload.runner]: e.payload.until };
  }
  if (e.kind === "org.hired" || e.kind === "org.released") {
    step.roster = { employeeId: e.employeeId, hired: e.kind === "org.hired" };
  }
  return step;
};
