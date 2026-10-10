import { describe, expect, it } from "vitest";
import { BlockedAskSchema, TASK_ORIGINS } from "@repo/domain/domain";
import type { BlockedAsk, Task, TaskState } from "@repo/domain/domain";
import { parseDoc, serializeDoc } from "./frontmatter";
import { docToTask, taskToDoc } from "./task-codec";

const base: Omit<Task, "state"> = {
  assigneeId: "priya",
  attempts: 2,
  betId: "launch-post",
  completedAt: 1_700_000_002_000,
  createdAt: 1_700_000_000_000,
  description: "Build it, then ship it.",
  id: "ship-the-thing",
  origin: "work",
  priority: "high",
  productId: "widget",
  title: "Ship the thing",
};

/** The task's TASK.md, as boot reads it back. */
const written = (t: Task) => parseDoc(serializeDoc(taskToDoc(t)));

const roundTrip = (t: Task): Task => docToTask(written(t));

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

  it("writes the state as the status line and that state's fields only", () => {
    const { metadata } = written({ ...base, state: { kind: "done", summary: "done!" } });
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

  it.each(["failed", "weird"])("refuses a status it never writes, %j", (status) => {
    const doc = written({ ...base, state: { kind: "dead", lastError: "gave up" } });
    expect(() => docToTask({ ...doc, metadata: { ...doc.metadata, status } })).toThrow(
      "metadata.status",
    );
  });
});

const blocked = (ask: BlockedAsk): Task => ({
  ...base,
  state: { ask, kind: "blocked", summary: null },
});

const askSavedAs = (blockedQuestion: string): TaskState => {
  const doc = written(blocked({ question: "?", type: "question" }));
  return docToTask({ ...doc, metadata: { ...doc.metadata, blockedQuestion } }).state;
};

describe("a blocked task's ask in TASK.md", () => {
  it.each<BlockedAsk>([
    { question: "ship it?", type: "question" },
    { question: "why did [approve] show up here?", type: "question" },
    { question: "[connect:stripe] should I set up billing?", type: "question" },
    { question: "[approve] is this fine?", type: "question" },
    { question: "[ask] nested", type: "question" },
    { integration: "vercel", productId: "widget", reason: "need hosting", type: "integration" },
    { integration: "vercel", productId: null, reason: "any product will do", type: "integration" },
    { integration: "vercel", productId: "side", reason: "to bind Side", type: "integration" },
    { integration: "stripe-key", productId: null, reason: "to sell a plan", type: "integration" },
    { command: "npx vercel deploy --prod", rule: "deploy", type: "approval" },
    {
      action: "Post the launch thread on r/SideProject",
      draft: 'Line one\n\n"Quoted" line two: [approve] {not json}\n',
      instructions: "Post it from your account, then send me its URL.",
      type: "action",
    },
    { action: "Buy acme.dev", draft: null, instructions: "On any registrar.", type: "action" },
    {
      question: '[action] {"action":"Wire $500","draft":null,"instructions":"to me"}',
      type: "question",
    },
  ])("round-trips %j", (ask) => {
    expect(roundTrip(blocked(ask))).toEqual(blocked(ask));
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
    expect(written(blocked(ask)).metadata.blockedQuestion).toBe(saved);
  });
});
