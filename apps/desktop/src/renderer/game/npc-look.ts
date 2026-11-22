import type { WorkPose } from "@/renderer/game/office-poses";
import type { Dir } from "@repo/domain/character-frame";

/**
 * What the scheduler says an employee is doing. Only a working employee has a pose:
 * it is what their last tool call looked like, and means nothing once the run ends.
 */
export type Activity =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly pose: WorkPose }
  | { readonly kind: "blocked" };

/**
 * Where an employee is in their day — the director's phases.
 *
 *   queued    hired; waiting outside for their turn through the door
 *   entering  walking from the door to their seat
 *   settled   in the office: at their desk, or living the idle life
 *   leaving   walking to the door; gone when they get there
 */
export type Phase = "queued" | "entering" | "settled" | "leaving";

/** "!" when they wait on the founder, "…" while they think. */
export type Emote = "alert" | "think";

/** Standing still facing a way, or hands on the keyboard at their desk, facing its screen. */
export interface Stance {
  readonly kind: "still" | "typing";
  readonly facing: Dir;
}

interface Look {
  readonly emote: Emote | null;
  readonly stance: Stance | null;
}

export interface Situation {
  readonly phase: Phase;
  readonly activity: Activity;
  /** They asked the founder something this run. */
  readonly asking: boolean;
  /** An ask of theirs from any run still waits on the founder. */
  readonly waiting: boolean;
  /** On their way somewhere. */
  readonly walking: boolean;
  /** Which way their screen is while they sit at it; null away from their seat or deskless. */
  readonly desk: Dir | null;
}

const emoteOf = ({ activity, asking, waiting }: Situation) => {
  if (activity.kind === "blocked" || asking || waiting) {
    return "alert" satisfies Emote | null;
  }

  return (
    activity.kind === "working" && activity.pose === "thinking" ? "think" : null
  ) satisfies Emote | null;
};

const stanceOf = ({ activity, desk }: Situation) => {
  if (activity.kind === "idle") {
    return { facing: "down", kind: "still" } satisfies Stance;
  }

  if (desk && activity.kind === "working" && activity.pose === "typing") {
    return { facing: desk, kind: "typing" } satisfies Stance;
  }

  return { facing: desk ?? "down", kind: "still" } satisfies Stance;
};

export const lookOf = (situation: Situation) => {
  if (situation.phase === "queued") {
    return { emote: null, stance: null } satisfies Look;
  }

  const emote = emoteOf(situation);

  if (situation.phase !== "settled" || situation.walking) {
    return { emote, stance: null } satisfies Look;
  }

  return { emote, stance: stanceOf(situation) } satisfies Look;
};
