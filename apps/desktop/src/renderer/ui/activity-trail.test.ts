import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@/shared/activity";
import { trailOf } from "./activity-trail";

const inRun = { createdAt: 0, employeeId: "bo", runId: "r1", taskId: "t1" };

describe("trailOf", () => {
  it("leaves out what has nothing to say and what they last said", () => {
    const said: ActivityEvent = { ...inRun, id: 4, kind: "message", message: "Done." };
    const mine: ActivityEvent[] = [
      { ...inRun, id: 1, kind: "run.start" },
      { ...inRun, id: 2, kind: "tool_call", message: "Read index.html", payload: {} },
      { ...inRun, id: 3, kind: "status", message: "running" },
      said,
      {
        ...inRun,
        id: 5,
        kind: "run.end",
        payload: { outcome: { kind: "done" }, settled: "done", summary: "" },
      },
      {
        ...inRun,
        id: 6,
        kind: "task.retry",
        payload: { attempts: 1, error: "", maxAttempts: 3, retryAt: 0 },
      },
    ];
    expect(trailOf(mine, said).map((a) => a.id)).toEqual([2, 3]);
  });
});
