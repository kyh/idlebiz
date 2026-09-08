import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  parseBlockedAsk,
  serializeBlockedAsk,
} from "@/shared/domain";
import type { BlockedAsk, Task, TaskState, TaskStatus } from "@/shared/domain";
import { nullableNum, optNum, optStr, reqStr, strArray } from "@/main/store/frontmatter";
import type { FrontmatterDoc } from "@/main/store/frontmatter";

// Keep status and state-specific fields flat for compatibility with existing TASK.md files.
export const taskToDoc = (t: Task): FrontmatterDoc => {
  const metadata: FrontmatterDoc["metadata"] = {
    createdAt: t.createdAt,
    priority: t.priority,
    status: t.state.kind,
  };
  if (t.assigneeId !== null) {
    metadata.assigneeId = t.assigneeId;
  }
  if (t.productId !== null) {
    metadata.productId = t.productId;
  }
  const st = t.state;
  switch (st.kind) {
    case "todo": {
      break;
    }
    case "queued": {
      if (st.nextAttemptAt !== null) {
        metadata.nextAttemptAt = st.nextAttemptAt;
      }
      if (st.lastError !== null) {
        metadata.lastError = st.lastError;
      }
      break;
    }
    case "running": {
      metadata.runId = st.runId;
      break;
    }
    case "blocked": {
      metadata.blockedQuestion = serializeBlockedAsk(st.ask);
      if (st.summary !== null) {
        metadata.summary = st.summary;
      }
      break;
    }
    case "done": {
      if (st.summary !== null) {
        metadata.summary = st.summary;
      }
      break;
    }
    case "dead": {
      metadata.lastError = st.lastError;
      break;
    }
    default: {
      break;
    }
  }
  if (t.artifacts.length > 0) {
    metadata.artifacts = JSON.stringify(t.artifacts);
  }
  if (t.attempts > 0) {
    metadata.attempts = t.attempts;
  }
  if (t.startedAt !== null) {
    metadata.startedAt = t.startedAt;
  }
  if (t.completedAt !== null) {
    metadata.completedAt = t.completedAt;
  }
  return {
    body: t.description ? `${t.description}\n` : "",
    fields: {
      kind: "task",
      name: t.title,
      schema: "agentcompanies/v1",
      slug: t.id,
    },
    metadata,
  };
};

/** Statuses older saves wrote that the queue no longer produces: both are terminal. */
const LEGACY_TERMINAL_STATUSES = new Set(["failed", "cancelled"]);

const parseTaskStatus = (raw: string | null): TaskStatus => {
  if (raw !== null && LEGACY_TERMINAL_STATUSES.has(raw)) {
    return "dead";
  }
  return TASK_STATUSES.find((s) => s === raw) ?? "todo";
};

const LOST_ASK: BlockedAsk = { question: "(question lost)", type: "question" };

const parseTaskState = (m: FrontmatterDoc["metadata"]): TaskState => {
  const status = parseTaskStatus(optStr(m, "status"));
  const summary = optStr(m, "summary");
  const lastError = optStr(m, "lastError");
  switch (status) {
    case "todo": {
      return { kind: "todo" };
    }
    case "queued": {
      return { kind: "queued", lastError, nextAttemptAt: nullableNum(m, "nextAttemptAt") };
    }
    case "running": {
      const runId = optStr(m, "runId");
      return runId === null
        ? { kind: "queued", lastError: "run lock lost", nextAttemptAt: null }
        : { kind: "running", runId };
    }
    case "blocked": {
      const asked = optStr(m, "blockedQuestion");
      return { ask: asked === null ? LOST_ASK : parseBlockedAsk(asked), kind: "blocked", summary };
    }
    case "done": {
      return { kind: "done", summary };
    }
    case "dead": {
      return { kind: "dead", lastError: lastError ?? summary ?? "unknown failure" };
    }
    default: {
      return { kind: "todo" };
    }
  }
};

export const docToTask = (doc: FrontmatterDoc, companyId: string): Task => {
  const f = doc.fields;
  const m = doc.metadata;
  const prioRaw = optStr(m, "priority");
  const priority = TASK_PRIORITIES.find((p) => p === prioRaw) ?? "medium";
  const body = doc.body.trim();
  return {
    artifacts: strArray(m, "artifacts"),
    assigneeId: optStr(m, "assigneeId"),
    attempts: optNum(m, "attempts", 0),
    companyId,
    completedAt: nullableNum(m, "completedAt"),
    createdAt: optNum(m, "createdAt", Date.now()),
    description: body === "" ? null : body,
    id: reqStr(f, "slug"),
    priority,
    productId: optStr(m, "productId"),
    startedAt: nullableNum(m, "startedAt"),
    state: parseTaskState(m),
    title: reqStr(f, "name"),
  };
};
