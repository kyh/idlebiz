import { describe, expect, it } from "vitest";
import { outcomeOf } from "./agent-driver";

const failed = { error: "usage limit reached", kind: "failed" } as const;

describe("outcomeOf", () => {
  it("is done when the turn completed with nothing asked", () => {
    expect(outcomeOf({ kind: "completed" }, null, null, false)).toEqual({ kind: "done" });
  });

  it("waits on the founder whenever something was asked, however the turn ended", () => {
    const ask = { question: "Ship it?", type: "question" } as const;
    expect(outcomeOf(failed, ask, 99, false)).toEqual({ ask, kind: "blocked" });
    expect(outcomeOf(failed, ask, null, true)).toEqual({ ask, kind: "blocked" });
  });

  it("rests on a usage limit and fails on anything else", () => {
    expect(outcomeOf(failed, null, 99, false)).toMatchObject({ kind: "resting", until: 99 });
    expect(outcomeOf(failed, null, null, false)).toMatchObject({ kind: "failed" });
  });

  it("does not hold the task to a turn the app stopped, unless it finished anyway", () => {
    expect(outcomeOf(failed, null, null, true)).toEqual({ kind: "interrupted" });
    expect(outcomeOf({ kind: "completed" }, null, null, true)).toEqual({ kind: "done" });
  });
});
