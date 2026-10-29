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
