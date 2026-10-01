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

const settled = (activity: Activity, asking: boolean, desk: Dir | null): Situation => ({
  activity,
  asking,
  desk,
  phase: "settled",
  waiting: false,
  walking: false,
});

const still = (facing: Dir): Stance => ({ facing, kind: "still" });
const typing = (facing: Dir): Stance => ({ facing, kind: "typing" });

describe("lookOf, settled and standing still", () => {
  it.each<[keyof typeof ACTIVITIES, boolean, Dir | null, Emote | null, Stance]>([
    ["idle", false, "up", null, still("down")],
    ["idle", false, null, null, still("down")],
    ["idle", true, "up", "alert", still("down")],
    ["idle", true, null, "alert", still("down")],
    ["typing", false, "up", null, typing("up")],
    ["typing", false, null, null, still("down")],
    ["typing", true, "up", "alert", typing("up")],
    ["typing", true, null, "alert", still("down")],
    ["reading", false, "up", null, still("up")],
    ["reading", false, null, null, still("down")],
    ["reading", true, "up", "alert", still("up")],
    ["reading", true, null, "alert", still("down")],
    ["thinking", false, "up", "think", still("up")],
    ["thinking", false, null, "think", still("down")],
    ["thinking", true, "up", "alert", still("up")],
    ["thinking", true, null, "alert", still("down")],
    ["blocked", false, "up", "alert", still("up")],
    ["blocked", false, null, "alert", still("down")],
    ["blocked", true, "up", "alert", still("up")],
    ["blocked", true, null, "alert", still("down")],
  ])("%s, asking %s, desk %s", (activity, asking, desk, emote, stance) => {
    expect(lookOf(settled(ACTIVITIES[activity], asking, desk))).toEqual({ emote, stance });
  });
});

describe("lookOf, at a desk whose screen is not north of them", () => {
  it.each<Dir>(["down", "left"])("works and waits facing the screen %s", (desk) => {
    expect(lookOf(settled(ACTIVITIES.typing, false, desk)).stance).toEqual(typing(desk));
    expect(lookOf(settled(ACTIVITIES.reading, false, desk)).stance).toEqual(still(desk));
    expect(lookOf(settled(ACTIVITIES.blocked, false, desk)).stance).toEqual(still(desk));
  });
});

describe("lookOf, while an ask of theirs waits on the founder", () => {
  it.each(Object.entries(ACTIVITIES))('keeps the "!" over them %s', (_name, activity) => {
    const look = lookOf({ ...settled(activity, false, "up"), waiting: true });
    expect(look.emote).toBe("alert");
  });
});

describe("lookOf, anywhere else", () => {
  it("shows nothing while they wait outside, whatever they were asked or told", () => {
    for (const activity of Object.values(ACTIVITIES)) {
      expect(lookOf({ ...settled(activity, true, "up"), phase: "queued" })).toEqual({
        emote: null,
        stance: null,
      });
    }
  });

  it.each<Phase>(["entering", "leaving"])(
    "keeps the emote but leaves the walk alone while %s",
    (phase) => {
      const walker = (activity: Activity, asking: boolean): Situation => ({
        ...settled(activity, asking, null),
        phase,
      });
      expect(lookOf(walker(ACTIVITIES.blocked, false))).toEqual({ emote: "alert", stance: null });
      expect(lookOf(walker(ACTIVITIES.idle, true))).toEqual({ emote: "alert", stance: null });
      expect(lookOf(walker(ACTIVITIES.thinking, false))).toEqual({ emote: "think", stance: null });
      expect(lookOf(walker(ACTIVITIES.typing, false))).toEqual({ emote: null, stance: null });
    },
  );

  it("leaves a settled walker's body to the walk, emote and all", () => {
    expect(lookOf({ ...settled(ACTIVITIES.idle, true, null), walking: true })).toEqual({
      emote: "alert",
      stance: null,
    });
    expect(lookOf({ ...settled(ACTIVITIES.typing, false, "up"), walking: true })).toEqual({
      emote: null,
      stance: null,
    });
  });
});
