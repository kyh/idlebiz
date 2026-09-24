// What an employee shows while standing still, as a pure function: the stance of their
// body and the emote over their head, from where they are in their day and what the
// scheduler says they are doing. Walking is animated by the movement code; npc.ts puts
// the rest on the sprite.
import type { Dir } from "@/renderer/game/character-sheet";
import type { WorkPose } from "@/renderer/game/office-poses";

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

/** Standing still facing a way, or hands on the keyboard at their desk. */
export type Stance = { readonly kind: "still"; readonly facing: Dir } | { readonly kind: "typing" };

interface Look {
  readonly emote: Emote | null;
  /** null leaves the body alone: they are still outside, or a walk is animating it. */
  readonly stance: Stance | null;
}

export interface Situation {
  readonly phase: Phase;
  readonly activity: Activity;
  /** They asked the founder something this run. */
  readonly asking: boolean;
  /** On their way somewhere. */
  readonly walking: boolean;
  /** On their seat, as opposed to away from it or deskless. */
  readonly atDesk: boolean;
}

const emoteOf = ({ activity, asking }: Situation): Emote | null => {
  if (activity.kind === "blocked" || asking) {
    return "alert";
  }
  return activity.kind === "working" && activity.pose === "thinking" ? "think" : null;
};

const stanceOf = ({ activity, atDesk }: Situation): Stance => {
  if (activity.kind === "idle") {
    return { facing: "down", kind: "still" };
  }
  if (atDesk && activity.kind === "working" && activity.pose === "typing") {
    return { kind: "typing" };
  }
  // reading / thinking / blocked: still, facing the screen (or the room, deskless)
  return { facing: atDesk ? "up" : "down", kind: "still" };
};

export const lookOf = (situation: Situation): Look => {
  // still outside: an emote here would hang over the door with nobody under it
  if (situation.phase === "queued") {
    return { emote: null, stance: null };
  }
  const emote = emoteOf(situation);
  if (situation.phase !== "settled" || situation.walking) {
    return { emote, stance: null };
  }
  return { emote, stance: stanceOf(situation) };
};
