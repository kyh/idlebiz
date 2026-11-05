// What the office changes to agree with main once the page hears main again, as a pure function.
//
// The office takes who is in and what they do from main's events alone, and those main sent while
// the page heard nothing are lost. So once the roster and the tasks are read again, the office is
// set right by them: npcs.ts carries out what this decides.

import type { Employee, EmployeeStatus } from "@repo/domain/domain";
import type { Activity, Phase } from "@/renderer/game/npc-look";

type State = Activity["kind"];

/** An employee in the office as the resync sees them. */
export interface InOffice {
  readonly id: string;
  readonly phase: Phase;
  readonly activity: State;
}

interface Resync {
  /** On main's roster and not in the office: they come in through the door. */
  readonly arrive: readonly Employee[];
  /** In the office and off main's roster: they leave through it. */
  readonly leave: readonly string[];
  /** Doing something other than main says, and what that is. Nobody else is set again. */
  readonly set: readonly (readonly [id: string, state: State])[];
}

/** What someone is doing by main: their run, else an ask of theirs at their desk, else nothing. */
export const activityOf = (status: EmployeeStatus, waiting: boolean): State => {
  if (status === "working") {
    return "working";
  }
  return waiting ? "blocked" : "idle";
};

/**
 * What hearing again who main says waits on the founder sets someone to, or null when they
 * already agree: whoever is not working is as `activityOf` puts them, at their desk with an ask,
 * else free. Both ways, so the office ends where boot and a resync would, whichever read lands
 * last: one made before a run's ask can land after the run ended blocked.
 */
export const onWaitingHeard = (activity: State, waiting: boolean): State | null => {
  if (activity === "working") {
    return null;
  }
  const state = waiting ? "blocked" : "idle";
  return state === activity ? null : state;
};

/**
 * Who comes in, who leaves and who is set doing something else, for the office to agree with
 * main's roster and with who main says waits on the founder. Setting someone resets their pose
 * and their wander, so only who disagrees is set; someone already on their way out is left to go.
 */
export const resyncOf = (
  office: readonly InOffice[],
  roster: readonly Employee[],
  waiting: ReadonlySet<string>,
): Resync => {
  const here = new Map(office.map((npc) => [npc.id, npc]));
  const staying = new Set(roster.map((emp) => emp.id));
  return {
    arrive: roster.filter((emp) => !here.has(emp.id)),
    leave: office
      .filter((npc) => npc.phase !== "leaving" && !staying.has(npc.id))
      .map((npc) => npc.id),
    set: roster.flatMap((emp) => {
      const npc = here.get(emp.id);
      const state = activityOf(emp.status, waiting.has(emp.id));
      return npc && npc.phase !== "leaving" && npc.activity !== state
        ? [[emp.id, state] as const]
        : [];
    }),
  };
};

/**
 * What is heard of hires the office has yet to show. A spawn waits on their sheet, and a run that
 * starts or settles meanwhile would find nobody to set, so each comes in doing what was heard
 * last, else what the roster that let them in says. Someone can be queued more than once (a
 * resync again while their sheet loads), so they stay on the way until every spawn of theirs ends.
 */
export class Arrivals {
  private readonly onTheWay = new Map<string, { spawns: number; heard: State | null }>();

  /** A spawn of theirs is queued. */
  expect(id: string): void {
    const arrival = this.onTheWay.get(id);
    if (arrival) {
      arrival.spawns += 1;
    } else {
      this.onTheWay.set(id, { heard: null, spawns: 1 });
    }
  }

  /** Whether `id` is still on the way; if so, they come in showing `state`. */
  hear(id: string, state: State): boolean {
    const arrival = this.onTheWay.get(id);
    if (!arrival) {
      return false;
    }
    arrival.heard = state;
    return true;
  }

  /** Their ask was answered while they were on the way: they come in idle, not asking. */
  unblock(id: string): void {
    const arrival = this.onTheWay.get(id);
    if (arrival?.heard === "blocked") {
      arrival.heard = "idle";
    }
  }

  /** What they come in doing, given what the roster said: what was heard is spent. */
  arrived(id: string, fromRoster: State): State {
    const arrival = this.onTheWay.get(id);
    const state = arrival?.heard ?? fromRoster;
    if (arrival) {
      arrival.heard = null;
    }
    return state;
  }

  /** A spawn of theirs ended, whether they came in or not. */
  forget(id: string): void {
    const arrival = this.onTheWay.get(id);
    if (!arrival) {
      return;
    }
    arrival.spawns -= 1;
    if (arrival.spawns === 0) {
      this.onTheWay.delete(id);
    }
  }
}
