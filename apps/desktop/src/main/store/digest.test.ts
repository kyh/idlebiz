import { describe, expect, it } from "vitest";
import { emptyDigest, foldDigest } from "./digest";

const inRun = { employeeId: "priya", runId: "r1", taskId: "t1" };

describe("folding the digest", () => {
  it("counts every ship but keeps only the lines its window lists", () => {
    let d = emptyDigest(0);
    for (let i = 0; i < 12; i += 1) {
      d = foldDigest(d, { ...inRun, createdAt: i, kind: "ship", message: `ship ${i}` }) ?? d;
    }
    expect(d.shipped).toBe(12);
    expect(d.ships).toEqual(["ship 7", "ship 8", "ship 9", "ship 10", "ship 11"]);
  });

  it("sums runs and what they cost, a run without a recorded cost as nothing", () => {
    const done = { kind: "done" } as const;
    const once = foldDigest(emptyDigest(0), {
      ...inRun,
      createdAt: 1,
      kind: "run.end",
      payload: { costUsd: 0.25, outcome: done, summary: "" },
    });
    const twice =
      once &&
      foldDigest(once, {
        ...inRun,
        createdAt: 2,
        kind: "run.end",
        payload: { outcome: done, summary: "" },
      });
    expect(twice).toMatchObject({ runs: 2, spentUsd: 0.25 });
  });

  it("leaves alone what it does not count", () => {
    expect(
      foldDigest(emptyDigest(0), { ...inRun, createdAt: 1, kind: "message", message: "hi" }),
    ).toBeNull();
  });
});
