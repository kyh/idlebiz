import { describe, expect, it } from "vitest";
import { BlockedAskSchema, TASK_ORIGINS } from "@/shared/domain";
import type { BlockedAsk, Task, TaskState } from "@/shared/domain";
import { parseDoc, serializeDoc } from "./frontmatter";
import { docToTask, taskToDoc } from "./task-codec";

const base: Omit<Task, "state"> = {
  artifacts: ["dist/index.html"],
  assigneeId: "priya",
  attempts: 2,
  betId: "launch-post",
  companyId: "acme",
  completedAt: 1_700_000_002_000,
  createdAt: 1_700_000_000_000,
  description: "Build it, then ship it.",
  id: "ship-the-thing",
  origin: "work",
  priority: "high",
  productId: "widget",
  startedAt: 1_700_000_001_000,
  title: "Ship the thing",
};

const roundTrip = (t: Task): Task => docToTask(parseDoc(serializeDoc(taskToDoc(t))), t.companyId);

describe("task codec", () => {
  it.each<TaskState>([
    { kind: "todo" },
    { kind: "queued", lastError: null, nextAttemptAt: null },
    { kind: "queued", lastError: "boom", nextAttemptAt: 1_700_000_003_000 },
    { kind: "running", runId: "run-1" },
    { ask: { question: "ship it?", type: "question" }, kind: "blocked", summary: "halfway" },
    {
      ask: { command: "npx vercel deploy", rule: "deploy", type: "approval" },
      kind: "blocked",
      summary: null,
    },
    { kind: "done", summary: "shipped to https://x.y" },
    { kind: "done", summary: null },
    { by: "continue-ship-the-thing", kind: "superseded" },
    { by: null, kind: "superseded" },
    { kind: "dropped", reason: "bet killed" },
    { kind: "dead", lastError: "five strikes" },
  ])("round-trips $kind", (state) => {
    const task: Task = { ...base, state };
    expect(roundTrip(task)).toEqual(task);
  });

  it.each(TASK_ORIGINS)("round-trips why a %s task exists", (origin) => {
    const task: Task = { ...base, origin, state: { kind: "todo" } };
    expect(roundTrip(task)).toEqual(task);
  });

  it("reads an unknown or missing origin as the bet's work or the founder's, never a proposal", () => {
    const doc = taskToDoc({ ...base, origin: "propose", state: { kind: "todo" } });
    const { origin: _unstamped, ...funded } = doc.metadata;
    const { betId: _unfunded, ...unfunded } = funded;
    const read = (metadata: typeof doc.metadata) => docToTask({ ...doc, metadata }, "acme").origin;
    expect(read(funded)).toBe("work");
    expect(read(unfunded)).toBe("founder");
    expect(read({ ...unfunded, origin: "hunch" })).toBe("founder");
  });

  it("writes the state as the status line and that state's fields only", () => {
    const { metadata } = taskToDoc({ ...base, state: { kind: "done", summary: "done!" } });
    expect(metadata.status).toBe("done");
    expect(metadata.summary).toBe("done!");
    expect("runId" in metadata).toBe(false);
    expect("lastError" in metadata).toBe(false);
    expect("blockedQuestion" in metadata).toBe(false);
  });

  it.each<TaskState>([
    { kind: "queued", lastError: null, nextAttemptAt: null },
    { ask: { question: "ship it?", type: "question" }, kind: "blocked", summary: null },
    { kind: "done", summary: null },
    { by: null, kind: "superseded" },
  ])("gives a $kind task's empty fields no line", (state) => {
    expect(serializeDoc(taskToDoc({ ...base, state }))).not.toContain("null");
  });

  it("reads statuses older saves wrote as dead, keeping the error", () => {
    const doc = taskToDoc({ ...base, state: { kind: "dead", lastError: "gave up" } });
    for (const legacy of ["failed", "cancelled"]) {
      const out = docToTask({ ...doc, metadata: { ...doc.metadata, status: legacy } }, "acme");
      expect(out.state).toEqual({ kind: "dead", lastError: "gave up" });
    }
  });

  it("keeps a dropped task dropped when its reason is missing", () => {
    const doc = taskToDoc({ ...base, state: { kind: "dropped", reason: "bet closed" } });
    const { dropReason: _lost, ...withoutReason } = doc.metadata;
    const out = docToTask({ ...doc, metadata: withoutReason }, "acme");
    expect(out.state).toEqual({ kind: "dropped", reason: "no reason kept" });
  });

  it("treats a running task whose lock is missing as a retry, not a run", () => {
    const doc = taskToDoc({ ...base, state: { kind: "running", runId: "run-1" } });
    const { runId: _lost, ...withoutLock } = doc.metadata;
    const out = docToTask({ ...doc, metadata: withoutLock }, "acme");
    expect(out.state).toEqual({ kind: "queued", lastError: "run lock lost", nextAttemptAt: null });
  });

  it("keeps a blocked task waiting when its ask is missing, so the founder can still unstick it", () => {
    const doc = taskToDoc({
      ...base,
      state: { ask: { question: "?", type: "question" }, kind: "blocked", summary: null },
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

const blocked = (ask: BlockedAsk): Task => ({
  ...base,
  state: { ask, kind: "blocked", summary: null },
});

const askSavedAs = (blockedQuestion: string): TaskState => {
  const doc = taskToDoc(blocked({ question: "?", type: "question" }));
  return docToTask({ ...doc, metadata: { ...doc.metadata, blockedQuestion } }, "acme").state;
};

describe("a blocked task's ask in TASK.md", () => {
  it.each<BlockedAsk>([
    { question: "ship it?", type: "question" },
    { question: "why did [approve] show up here?", type: "question" },
    { question: "[connect:stripe] should I set up billing?", type: "question" },
    { question: "[approve] is this fine?", type: "question" },
    { question: "[ask] nested", type: "question" },
    { integration: "vercel", reason: "need hosting", type: "integration" },
    { command: "npx vercel deploy --prod", rule: "deploy", type: "approval" },
  ])("round-trips %j", (ask) => {
    expect(roundTrip(blocked(ask))).toEqual(blocked(ask));
  });

  it("reads an approval without a rule id as held by the broadest rule", () => {
    expect(askSavedAs("[approve] git push origin main")).toEqual(
      blocked({ command: "git push origin main", rule: "write-outside", type: "approval" }).state,
    );
  });

  it("preserves a retired rule through validation and TASK.md", () => {
    const saved = "[approve:retired-rule] git push origin main";
    const ask: BlockedAsk = {
      command: "git push origin main",
      rule: "retired-rule",
      type: "approval",
    };
    expect(askSavedAs(saved)).toEqual(blocked(ask).state);
    expect(BlockedAskSchema.parse(ask)).toEqual(ask);
    expect(taskToDoc(blocked(ask)).metadata.blockedQuestion).toBe(saved);
  });
});

describe("a task nobody owns", () => {
  it.each(["queued", "running"])(
    "reads a %s task with no assignee as work to pick up",
    (status) => {
      const task = docToTask(
        {
          body: "",
          fields: { kind: "task", name: "Orphan", slug: "orphan" },
          metadata: { createdAt: 1, runId: "run", status },
        },
        "co",
      );
      expect(task.state).toEqual({ kind: "todo" });
    },
  );
});
