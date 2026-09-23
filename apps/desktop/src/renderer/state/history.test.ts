import { describe, expect, it } from "vitest";
import * as timeline from "./history";
import type { Timeline } from "./history";

interface Doc {
  n: number;
}

const CAP = 100;
const zero: Doc = { n: 0 };
const to =
  (n: number) =>
  (d: Doc): Doc =>
    d.n === n ? d : { n };
const same = (d: Doc): Doc => d;

/** A gesture: begin, one live edit per frame, end. */
const stroke = (t: Timeline<Doc>, frames: readonly ((d: Doc) => Doc)[]): Timeline<Doc> => {
  let open = timeline.begin(t);
  for (const frame of frames) {
    open = timeline.live(open, frame);
  }
  return timeline.end(open, CAP);
};

/** One commit per value, in order. */
const commits = (t: Timeline<Doc>, values: readonly number[], cap = CAP): Timeline<Doc> => {
  let next = t;
  for (const n of values) {
    next = timeline.commit(next, to(n), cap);
  }
  return next;
};

describe("history timeline", () => {
  it("hands back the same timeline from a live edit that changes nothing", () => {
    const t = timeline.start(zero);
    expect(timeline.live(t, same)).toBe(t);
    expect(timeline.live(t, to(0))).toBe(t);
  });

  it("replaces the present on a live edit without recording it", () => {
    const t = timeline.live(timeline.start(zero), to(1));
    expect(t.present).toEqual({ n: 1 });
    expect(t.past).toEqual([]);
  });

  it("records nothing for an empty stroke", () => {
    const t = stroke(timeline.start(zero), [same, to(0), same]);
    expect(t.present).toBe(zero);
    expect(t.past).toEqual([]);
    expect(t.open).toBeNull();
  });

  it("records a whole stroke as one step", () => {
    const t = stroke(timeline.start(zero), [to(1), to(2), to(3)]);
    expect(t.past).toEqual([zero]);
    const undone = timeline.undo(t);
    expect(undone.present).toBe(zero);
    expect(timeline.redo(undone).present).toEqual({ n: 3 });
  });

  it("refuses undo and redo while a gesture is open", () => {
    const open = timeline.live(
      timeline.begin(timeline.undo(commits(timeline.start(zero), [1, 2]))),
      to(3),
    );
    expect(open.past).toHaveLength(1);
    expect(open.future).toHaveLength(1);
    expect(timeline.undo(open)).toBe(open);
    expect(timeline.redo(open)).toBe(open);
  });

  it("clears the future when a gesture after an undo changes something", () => {
    const undone = timeline.undo(timeline.commit(timeline.start(zero), to(1), CAP));
    expect(undone.future).toEqual([{ n: 1 }]);
    expect(stroke(undone, [same]).future).toEqual([{ n: 1 }]);
    expect(stroke(undone, [to(2)]).future).toEqual([]);
  });

  it("folds a commit made mid-gesture into the gesture's step", () => {
    const open = timeline.live(timeline.begin(timeline.start(zero)), to(1));
    const t = timeline.end(timeline.commit(open, to(2), CAP), CAP);
    expect(t.present).toEqual({ n: 2 });
    expect(t.past).toEqual([zero]);
  });

  it("records nothing for a commit that changes nothing", () => {
    const t = timeline.commit(timeline.start(zero), same, CAP);
    expect(t.present).toBe(zero);
    expect(t.past).toEqual([]);
  });

  it("keeps only the newest steps up to the cap", () => {
    expect(commits(timeline.start(zero), [1, 2, 3], 2).past).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
