import { describe, expect, it } from "vitest";
import type { Task, TaskState } from "@/shared/domain";
import { parseDoc, serializeDoc } from "./frontmatter";
import { docToTask, taskToDoc } from "./task-codec";

const base: Omit<Task, "state"> = {
  id: "ship-the-thing",
  companyId: "acme",
  productId: "widget",
  title: "Ship the thing",
  description: "Build it, then ship it.",
  priority: "high",
  assigneeId: "priya",
  artifacts: ["dist/index.html"],
  attempts: 2,
  createdAt: 1_700_000_000_000,
  startedAt: 1_700_000_001_000,
  completedAt: 1_700_000_002_000,
};

/** Through the markdown and back: what the file says is what the store sees. */
const roundTrip = (t: Task): Task => docToTask(parseDoc(serializeDoc(taskToDoc(t))), t.companyId);

describe("task codec", () => {
  it.each<TaskState>([
    { kind: "todo" },
    { kind: "queued", nextAttemptAt: null, lastError: null },
    { kind: "queued", nextAttemptAt: 1_700_000_003_000, lastError: "boom" },
    { kind: "running", runId: "run-1" },
    { kind: "blocked", ask: { type: "question", question: "ship it?" }, summary: "halfway" },
    {
      kind: "blocked",
      ask: { type: "approval", command: "npx vercel deploy", rule: "deploy" },
      summary: null,
    },
    { kind: "done", summary: "shipped to https://x.y" },
    { kind: "done", summary: null },
    { kind: "dead", lastError: "five strikes" },
  ])("round-trips $kind", (state) => {
    const task: Task = { ...base, state };
    expect(roundTrip(task)).toEqual(task);
  });

  it("writes the state as the status line and that state's fields only", () => {
    const { metadata } = taskToDoc({ ...base, state: { kind: "done", summary: "done!" } });
    expect(metadata.status).toBe("done");
    expect(metadata.summary).toBe("done!");
    expect("runId" in metadata).toBe(false);
    expect("lastError" in metadata).toBe(false);
    expect("blockedQuestion" in metadata).toBe(false);
  });

  it("reads statuses older saves wrote as dead, keeping the error", () => {
    const doc = taskToDoc({ ...base, state: { kind: "dead", lastError: "gave up" } });
    for (const legacy of ["failed", "cancelled"]) {
      const out = docToTask({ ...doc, metadata: { ...doc.metadata, status: legacy } }, "acme");
      expect(out.state).toEqual({ kind: "dead", lastError: "gave up" });
    }
  });

  it("treats a running task whose lock is missing as a retry, not a run", () => {
    const doc = taskToDoc({ ...base, state: { kind: "running", runId: "run-1" } });
    const { runId: _lost, ...withoutLock } = doc.metadata;
    const out = docToTask({ ...doc, metadata: withoutLock }, "acme");
    expect(out.state).toEqual({ kind: "queued", nextAttemptAt: null, lastError: "run lock lost" });
  });

  it("keeps a blocked task waiting when its ask is missing, so the founder can still unstick it", () => {
    const doc = taskToDoc({
      ...base,
      state: { kind: "blocked", ask: { type: "question", question: "?" }, summary: null },
    });
    const { blockedQuestion: _lost, ...withoutAsk } = doc.metadata;
    const out = docToTask({ ...doc, metadata: withoutAsk }, "acme");
    expect(out.state.kind).toBe("blocked");
  });

  it("defaults an unknown status to todo", () => {
    const doc = taskToDoc({ ...base, state: { kind: "todo" } });
    const out = docToTask({ ...doc, metadata: { ...doc.metadata, status: "weird" } }, "acme");
    expect(out.state).toEqual({ kind: "todo" });
  });
});
