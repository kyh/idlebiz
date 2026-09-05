import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  parseBlockedAsk,
  serializeBlockedAsk,
} from "@/shared/domain";
import type { BlockedAsk, Task, TaskState, TaskStatus } from "@/shared/domain";
import {
  nullableNum,
  optNum,
  optStr,
  reqStr,
  strArray,
  type FrontmatterDoc,
} from "@/main/store/frontmatter";

// TASK.md ⇄ Task. Pure, so every state round-trips under test.

/**
 * TASK.md keeps the state as the flat scalars it always had — `status` plus
 * the fields that state carries — so a file written before the union reads
 * the same, and a founder reading one sees the same lines.
 */
export function taskToDoc(t: Task): FrontmatterDoc {
  const metadata: FrontmatterDoc["metadata"] = {
    status: t.state.kind,
    priority: t.priority,
    createdAt: t.createdAt,
  };
  if (t.assigneeId !== null) metadata.assigneeId = t.assigneeId;
  const st = t.state;
  switch (st.kind) {
    case "todo":
      break;
    case "queued":
      if (st.nextAttemptAt !== null) metadata.nextAttemptAt = st.nextAttemptAt;
      if (st.lastError !== null) metadata.lastError = st.lastError;
      break;
    case "running":
      metadata.runId = st.runId;
      break;
    case "blocked":
      metadata.blockedQuestion = serializeBlockedAsk(st.ask);
      if (st.summary !== null) metadata.summary = st.summary;
      break;
    case "done":
      if (st.summary !== null) metadata.summary = st.summary;
      break;
    case "dead":
      metadata.lastError = st.lastError;
      break;
  }
  if (t.artifacts.length > 0) metadata.artifacts = JSON.stringify(t.artifacts);
  if (t.attempts > 0) metadata.attempts = t.attempts;
  if (t.startedAt !== null) metadata.startedAt = t.startedAt;
  if (t.completedAt !== null) metadata.completedAt = t.completedAt;
  return {
    fields: {
      schema: "agentcompanies/v1",
      kind: "task",
      slug: t.id,
      name: t.title,
    },
    metadata,
    body: t.description ? `${t.description}\n` : "",
  };
}

/** Statuses older saves wrote that the queue no longer produces: both are terminal. */
const LEGACY_TERMINAL_STATUSES = new Set(["failed", "cancelled"]);

function parseTaskStatus(raw: string | null): TaskStatus {
  if (raw !== null && LEGACY_TERMINAL_STATUSES.has(raw)) return "dead";
  return TASK_STATUSES.find((s) => s === raw) ?? "todo";
}

/** A blocked task whose ask went missing is still waiting on the founder; say so. */
const LOST_ASK: BlockedAsk = { type: "question", question: "(question lost)" };

/** The state a file describes. A running task with no lock is one whose run was lost. */
function parseTaskState(m: FrontmatterDoc["metadata"]): TaskState {
  const status = parseTaskStatus(optStr(m, "status"));
  const summary = optStr(m, "summary");
  const lastError = optStr(m, "lastError");
  switch (status) {
    case "todo":
      return { kind: "todo" };
    case "queued":
      return { kind: "queued", nextAttemptAt: nullableNum(m, "nextAttemptAt"), lastError };
    case "running": {
      const runId = optStr(m, "runId");
      return runId === null
        ? { kind: "queued", nextAttemptAt: null, lastError: "run lock lost" }
        : { kind: "running", runId };
    }
    case "blocked": {
      const asked = optStr(m, "blockedQuestion");
      return { kind: "blocked", ask: asked === null ? LOST_ASK : parseBlockedAsk(asked), summary };
    }
    case "done":
      return { kind: "done", summary };
    case "dead":
      return { kind: "dead", lastError: lastError ?? summary ?? "unknown failure" };
  }
}

export function docToTask(doc: FrontmatterDoc, companyId: string): Task {
  const f = doc.fields;
  const m = doc.metadata;
  const prioRaw = optStr(m, "priority");
  const priority = TASK_PRIORITIES.find((p) => p === prioRaw) ?? "medium";
  const body = doc.body.trim();
  return {
    id: reqStr(f, "slug"),
    companyId,
    title: reqStr(f, "name"),
    description: body === "" ? null : body,
    state: parseTaskState(m),
    priority,
    assigneeId: optStr(m, "assigneeId"),
    artifacts: strArray(m, "artifacts"),
    attempts: optNum(m, "attempts", 0),
    createdAt: optNum(m, "createdAt", Date.now()),
    startedAt: nullableNum(m, "startedAt"),
    completedAt: nullableNum(m, "completedAt"),
  };
}
