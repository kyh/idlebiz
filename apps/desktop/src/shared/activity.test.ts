import { describe, expect, it } from "vitest";
import { PersistedActivitySchema } from "./activity";

describe("PersistedActivitySchema", () => {
  it("accepts a current row as-is", () => {
    const row = {
      createdAt: 2,
      employeeId: "priya",
      kind: "run.end",
      payload: { outcome: { kind: "done" }, summary: "done" },
      runId: "r1",
      taskId: "t1",
    };
    expect(PersistedActivitySchema.parse(row)).toEqual(row);
  });

  it("rejects a status the queue does not produce", () => {
    const row = { createdAt: 3, employeeId: "priya", kind: "status", message: "cancelled" };
    expect(PersistedActivitySchema.safeParse(row).success).toBe(false);
  });

  it("rejects a payload that does not fit its kind", () => {
    const row = { createdAt: 4, kind: "org.hired", payload: { name: "Ada" } };
    expect(PersistedActivitySchema.safeParse(row).success).toBe(false);
  });
});
