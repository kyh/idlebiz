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

  it("keeps a tool call to its kind, never the call's input", () => {
    const row = {
      createdAt: 1,
      kind: "tool_call",
      message: "Write .env",
      payload: { args: { content: "API_TOKEN=hunter2" }, kind: "edit" },
    };
    expect(PersistedActivitySchema.parse(row)).toEqual({ ...row, payload: { kind: "edit" } });
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
