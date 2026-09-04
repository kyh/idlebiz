import { describe, expect, it } from "vitest";
import { PersistedActivitySchema } from "./activity";

describe("PersistedActivitySchema", () => {
  it("lifts a row written when lifecycle events shared one kind", () => {
    const legacy = {
      employeeId: "priya",
      kind: "lifecycle",
      message: "runner.resting",
      payload: { runner: "claude", until: 1700000000000 },
      createdAt: 1,
    };
    const out = PersistedActivitySchema.parse(legacy);
    expect(out.kind).toBe("runner.resting");
    expect("message" in out).toBe(false);
  });

  it("reads a current row as-is", () => {
    const row = {
      runId: "r1",
      taskId: "t1",
      employeeId: "priya",
      kind: "run.end",
      payload: { summary: "done", outcome: { kind: "done" } },
      createdAt: 2,
    };
    expect(PersistedActivitySchema.parse(row)).toEqual(row);
  });

  it("rejects a status the queue does not produce", () => {
    const row = { employeeId: "priya", kind: "status", message: "cancelled", createdAt: 3 };
    expect(PersistedActivitySchema.safeParse(row).success).toBe(false);
  });

  it("rejects a payload that does not fit its kind", () => {
    const row = { kind: "org.hired", payload: { name: "Ada" }, createdAt: 4 };
    expect(PersistedActivitySchema.safeParse(row).success).toBe(false);
  });
});
