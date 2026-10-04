import { describe, expect, it } from "vitest";
import { emptyDigest, foldDigest } from "./digest";
import { DigestSchema } from "@repo/domain/digest";
import type { BlockedAsk } from "@repo/domain/domain";

const inRun = { employeeId: "priya", runId: "r1", taskId: "t1" };

const asked = (ask: BlockedAsk) =>
  foldDigest(emptyDigest(0), { ...inRun, createdAt: 1, kind: "run.ask", payload: { ask } });

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
      payload: { costUsd: 0.25, outcome: done, settled: "done", summary: "" },
    });
    const twice =
      once &&
      foldDigest(once, {
        ...inRun,
        createdAt: 2,
        kind: "run.end",
        payload: { outcome: done, settled: "done", summary: "" },
      });
    expect(twice).toMatchObject({ runs: 2, spentUsd: 0.25 });
  });

  it("counts the actions handed to the founder, not their questions", () => {
    expect(
      asked({
        action: "Buy acme.dev",
        draft: null,
        instructions: "Any registrar.",
        type: "action",
      }),
    ).toMatchObject({ actions: 1 });
    expect(asked({ question: "Monthly or yearly?", type: "question" })).toBeNull();
  });

  it("reads a digest from before it counted actions", () => {
    const { actions: _, ...older } = emptyDigest(0);
    expect(DigestSchema.parse(older)).toEqual(emptyDigest(0));
  });

  it("leaves alone what it does not count", () => {
    expect(
      foldDigest(emptyDigest(0), { ...inRun, createdAt: 1, kind: "message", message: "hi" }),
    ).toBeNull();
  });
});
