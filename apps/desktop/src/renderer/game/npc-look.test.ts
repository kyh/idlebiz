import { describe, expect, it } from "vitest";
import type { Dir } from "./character-sheet";
import { lookOf } from "./npc-look";
import type { Activity, Emote, Phase, Situation, Stance } from "./npc-look";

const ACTIVITIES = {
  blocked: { kind: "blocked" },
  idle: { kind: "idle" },
  reading: { kind: "working", pose: "reading" },
  thinking: { kind: "working", pose: "thinking" },
  typing: { kind: "working", pose: "typing" },
} satisfies Record<string, Activity>;

const settled = (activity: Activity, asking: boolean, atDesk: boolean): Situation => ({
  activity,
  asking,
  atDesk,
  phase: "settled",
  walking: false,
});

const still = (facing: Dir): Stance => ({ facing, kind: "still" });
const typing: Stance = { kind: "typing" };

describe("lookOf, settled and standing still", () => {
  it.each<[keyof typeof ACTIVITIES, boolean, boolean, Emote | null, Stance]>([
    ["idle", false, true, null, still("down")],
    ["idle", false, false, null, still("down")],
    ["idle", true, true, "alert", still("down")],
    ["idle", true, false, "alert", still("down")],
    ["typing", false, true, null, typing],
    ["typing", false, false, null, still("down")],
    ["typing", true, true, "alert", typing],
    ["typing", true, false, "alert", still("down")],
    ["reading", false, true, null, still("up")],
    ["reading", false, false, null, still("down")],
    ["reading", true, true, "alert", still("up")],
    ["reading", true, false, "alert", still("down")],
    ["thinking", false, true, "think", still("up")],
    ["thinking", false, false, "think", still("down")],
    ["thinking", true, true, "alert", still("up")],
    ["thinking", true, false, "alert", still("down")],
    ["blocked", false, true, "alert", still("up")],
    ["blocked", false, false, "alert", still("down")],
    ["blocked", true, true, "alert", still("up")],
    ["blocked", true, false, "alert", still("down")],
  ])("%s, asking %s, at desk %s", (activity, asking, atDesk, emote, stance) => {
    expect(lookOf(settled(ACTIVITIES[activity], asking, atDesk))).toEqual({ emote, stance });
  });
});

describe("lookOf, anywhere else", () => {
  it("shows nothing while they wait outside, whatever they were asked or told", () => {
    for (const activity of Object.values(ACTIVITIES)) {
      expect(lookOf({ ...settled(activity, true, true), phase: "queued" })).toEqual({
        emote: null,
        stance: null,
      });
    }
  });

  it.each<Phase>(["entering", "leaving"])(
    "keeps the emote but leaves the walk alone while %s",
    (phase) => {
      const walker = (activity: Activity, asking: boolean): Situation => ({
        ...settled(activity, asking, false),
        phase,
      });
      expect(lookOf(walker(ACTIVITIES.blocked, false))).toEqual({ emote: "alert", stance: null });
      expect(lookOf(walker(ACTIVITIES.idle, true))).toEqual({ emote: "alert", stance: null });
      expect(lookOf(walker(ACTIVITIES.thinking, false))).toEqual({ emote: "think", stance: null });
      expect(lookOf(walker(ACTIVITIES.typing, false))).toEqual({ emote: null, stance: null });
    },
  );

  it("leaves a settled walker's body to the walk, emote and all", () => {
    expect(lookOf({ ...settled(ACTIVITIES.idle, true, false), walking: true })).toEqual({
      emote: "alert",
      stance: null,
    });
    expect(lookOf({ ...settled(ACTIVITIES.typing, false, true), walking: true })).toEqual({
      emote: null,
      stance: null,
    });
  });
});
