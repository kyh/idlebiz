import type { ActivityEvent } from "@/shared/activity";

/** An event with a line to show; the rest (a run starting or ending, a retry) are bookkeeping. */
export type Said = Extract<ActivityEvent, { message: string }>;

const TRAIL_LENGTH = 3;

/** What an employee did lately, under what they last said. */
export const trailOf = (
  mine: readonly ActivityEvent[],
  latest: ActivityEvent | undefined,
): Said[] => mine.filter((a): a is Said => a !== latest && "message" in a).slice(-TRAIL_LENGTH);

/**
 * The newest event that can move this employee's tasks: a status of theirs, or a company
 * change that drops or rehomes waiting work with no status per task (a bet leaving open, a
 * retired product, a release handing the leaver's asks to the lead).
 */
export const tasksMovedBy = (
  activity: readonly ActivityEvent[],
  employeeId: string,
): number | null =>
  activity.findLast(
    (a) =>
      (a.kind === "status" && a.employeeId === employeeId) ||
      a.kind === "bet.changed" ||
      a.kind === "product.killed" ||
      a.kind === "org.released",
  )?.id ?? null;
