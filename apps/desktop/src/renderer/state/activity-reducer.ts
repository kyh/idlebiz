import type { ActivityEvent } from "@/shared/activity";
import { employeeStatusOf } from "@/shared/domain";
import type { Employee } from "@/shared/domain";
import type { RestingRunners } from "@/shared/ipc-registry";

// What an event from main means for the renderer's copy of main's state, with
// no bridge and no Phaser in sight: a patch it can apply at once, and the
// slices it has to fetch again. Main's store is the truth; events only say
// which part of it moved.

/** A part of main's state the renderer holds a copy of. */
export type Slice = "company" | "products" | "bets" | "tasks" | "all";

const ACTIVITY_RING = 300;

interface Held {
  activity: readonly ActivityEvent[];
  employees: readonly Employee[];
  resting: RestingRunners;
}

export interface ActivityStep {
  patch: { activity: ActivityEvent[]; employees?: Employee[]; resting?: RestingRunners };
  reload: readonly Slice[];
  /** Someone joined or left: the office walks them through the door once the roster is fresh. */
  roster: { employeeId: string; hired: boolean } | null;
}

const reloadFor = (e: ActivityEvent): readonly Slice[] => {
  switch (e.kind) {
    case "metrics.pulse":
    case "autopilot.changed":
    case "budget.exhausted": {
      return ["company"];
    }
    case "product.created": {
      return ["products"];
    }
    case "product.killed": {
      return ["products", "bets"];
    }
    case "bet.changed": {
      return ["bets"];
    }
    // an ask exists the moment it is raised, and a dead letter the moment it dies:
    // the inbox must not wait for the run to end to agree with the office
    case "run.ask":
    case "task.dead": {
      return ["tasks"];
    }
    case "org.hired":
    case "org.released":
    case "run.end": {
      return ["all"];
    }
    case "tool_call":
    case "message":
    case "chat":
    case "ship":
    case "status":
    case "run.start":
    case "task.retry":
    case "runner.resting": {
      return [];
    }
    // no default
  }
};

export const reduceActivity = (held: Held, e: ActivityEvent): ActivityStep => {
  const ring = held.activity;
  const activity = ring.length >= ACTIVITY_RING ? [...ring.slice(1), e] : [...ring, e];
  const step: ActivityStep = { patch: { activity }, reload: reloadFor(e), roster: null };
  if (e.kind === "status" && e.employeeId) {
    const status = employeeStatusOf(e.message);
    step.patch.employees = held.employees.map((emp) =>
      emp.id === e.employeeId ? { ...emp, status } : emp,
    );
  }
  if (e.kind === "runner.resting") {
    step.patch.resting = { ...held.resting, [e.payload.runner]: e.payload.until };
  }
  if ((e.kind === "org.hired" || e.kind === "org.released") && e.employeeId) {
    step.roster = { employeeId: e.employeeId, hired: e.kind === "org.hired" };
  }
  return step;
};
