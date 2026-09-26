import type { ActivityEvent, ActivityKind } from "@/shared/activity";
import type { Employee, RestingRunners } from "@/shared/domain";

// What an event from main means for the renderer's copy of main's state, with
// no bridge and no Phaser in sight: a patch it can apply at once, and the
// slices it has to fetch again. Main's store is the truth; events only say
// which part of it moved.

/** A part of main's state the renderer holds a copy of. */
export type Slice = "company" | "employees" | "resting" | "products" | "bets" | "tasks" | "all";

const ACTIVITY_RING = 300;

/** What the #team feed shows. It keeps its own lines: tool calls fill the ring and would evict them. */
const FEED_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  "chat",
  "ship",
  "org.hired",
  "org.released",
  "runner.resting",
  "run.ask",
]);
const FEED_LINES = 30;

interface Held {
  activity: readonly ActivityEvent[];
  feed: readonly ActivityEvent[];
  employees: readonly Employee[];
  resting: RestingRunners;
}

export interface ActivityStep {
  patch: {
    activity: ActivityEvent[];
    feed?: ActivityEvent[];
    employees?: Employee[];
    resting?: RestingRunners;
  };
  reload: readonly Slice[];
  /** Someone joined or left: the office walks them through the door once the roster is fresh. */
  roster: { employeeId: string; hired: boolean } | null;
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
  const step: ActivityStep = { patch: { activity }, reload: RELOAD_FOR[e.kind], roster: null };
  if (FEED_KINDS.has(e.kind)) {
    step.patch.feed = [...held.feed, e].slice(-FEED_LINES);
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
