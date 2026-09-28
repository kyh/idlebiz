import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@/shared/activity";
import { tasksMovedBy, trailOf } from "./activity-trail";

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

describe("tasksMovedBy", () => {
  it("names the newest event that can move their tasks, theirs or the company's", () => {
    const events: ActivityEvent[] = [
      { ...inRun, id: 1, kind: "status", message: "running" },
      { ...inRun, employeeId: "ada", id: 2, kind: "status", message: "queued" },
      { ...inRun, id: 3, kind: "message", message: "Done." },
    ];
    expect(tasksMovedBy(events, "bo")).toBe(1);
    const companyMoves: ActivityEvent[] = [
      {
        createdAt: 0,
        id: 4,
        kind: "bet.changed",
        message: "Launch",
        payload: { betId: "b1", state: { closedAt: 0, kind: "killed", moved: 0, reason: "" } },
      },
      {
        createdAt: 0,
        employeeId: "ada",
        id: 5,
        kind: "product.killed",
        message: "Retired",
        payload: { productId: "p1", reason: "flat" },
      },
      {
        createdAt: 0,
        employeeId: "ada",
        id: 6,
        kind: "org.released",
        payload: { by: "founder", name: "Ada", reason: "" },
      },
    ];
    for (const moved of companyMoves) {
      expect(tasksMovedBy([...events, moved], "bo"), moved.kind).toBe(moved.id);
    }
  });
});
