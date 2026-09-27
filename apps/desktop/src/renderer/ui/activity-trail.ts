import type { ActivityEvent } from "@/shared/activity";

/** An event with a line to show; the rest (a run starting or ending, a retry) are bookkeeping. */
export type Said = Extract<ActivityEvent, { message: string }>;

const TRAIL_LENGTH = 3;

/** What an employee did lately, under what they last said. */
export const trailOf = (
  mine: readonly ActivityEvent[],
  latest: ActivityEvent | undefined,
): Said[] => mine.filter((a): a is Said => a !== latest && "message" in a).slice(-TRAIL_LENGTH);
