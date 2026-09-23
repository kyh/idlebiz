import { INTEGRATION_KINDS, TASK_ORIGINS, TASK_PRIORITIES, TASK_STATUSES } from "@/shared/domain";
import type { BlockedAsk, Task, TaskOrigin, TaskState, TaskStatus } from "@/shared/domain";
import {
  PACKAGE_SCHEMA,
  nullableNum,
  optNum,
  optStr,
  reqStr,
  strArray,
} from "@/main/store/frontmatter";
import type { FrontmatterDoc } from "@/main/store/frontmatter";

const QUESTION_ESCAPE = "[ask] ";

// TASK.md stores a human-editable scalar. A question that starts with "[" is escaped so an
// agent's text can never read back as an approval or connect ask.
const serializeBlockedAsk = (a: BlockedAsk): string => {
  if (a.type === "question") {
    return a.question.startsWith("[") ? `${QUESTION_ESCAPE}${a.question}` : a.question;
  }
  if (a.type === "approval") {
    return `[approve:${a.rule}] ${a.command}`;
  }
  return `[connect:${a.integration}] ${a.reason}`;
};

const parseBlockedAsk = (s: string): BlockedAsk => {
  if (s.startsWith(QUESTION_ESCAPE)) {
    return { question: s.slice(QUESTION_ESCAPE.length), type: "question" };
  }
  const approval = /^\[approve(?::(?<rule>[a-z-]+))?\]\s*(?<command>[\s\S]*)$/u.exec(s);
  if (approval) {
    const command = (approval.groups?.command ?? "").trim();
    const rule = approval.groups?.rule ?? "write-outside";
    return { command, rule, type: "approval" };
  }
  const m = /^\[connect:(?<kind>[a-z]+)\]\s*(?<reason>[\s\S]*)$/u.exec(s);
  const integration = INTEGRATION_KINDS.find((k) => k === m?.groups?.kind);
  if (!integration) {
    return { question: s, type: "question" };
  }
  return { integration, reason: (m?.groups?.reason ?? "").trim(), type: "integration" };
};

/** A state's own fields, written flat beside the status line; a null one gets no line. */
const stateFields = (st: TaskState): FrontmatterDoc["metadata"] => {
  switch (st.kind) {
    case "todo": {
      return {};
    }
    case "queued": {
      return { lastError: st.lastError, nextAttemptAt: st.nextAttemptAt };
    }
    case "running": {
      return { runId: st.runId };
    }
    case "blocked": {
      return { blockedQuestion: serializeBlockedAsk(st.ask), summary: st.summary };
    }
    case "done": {
      return { summary: st.summary };
    }
    case "superseded": {
      return { supersededBy: st.by };
    }
    case "dead": {
      return { lastError: st.lastError };
    }
    // no default
  }
};

// Keep status and state-specific fields flat for compatibility with existing TASK.md files.
export const taskToDoc = (t: Task): FrontmatterDoc => {
  const metadata: FrontmatterDoc["metadata"] = {
    createdAt: t.createdAt,
    origin: t.origin,
    priority: t.priority,
    status: t.state.kind,
  };
  if (t.assigneeId !== null) {
    metadata.assigneeId = t.assigneeId;
  }
  if (t.productId !== null) {
    metadata.productId = t.productId;
  }
  if (t.betId !== null) {
    metadata.betId = t.betId;
  }
  for (const [key, value] of Object.entries(stateFields(t.state))) {
    if (value !== null) {
      metadata[key] = value;
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
      schema: PACKAGE_SCHEMA,
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
    case "superseded": {
      return { by: optStr(m, "supersededBy"), kind: "superseded" };
    }
    case "dead": {
      return { kind: "dead", lastError: lastError ?? summary ?? "unknown failure" };
    }
    // no default
  }
};

/** An origin the save never wrote, or one this build does not know, reads as the bet's work or the founder's, never a proposal: at worst the lead is asked once more. */
const parseTaskOrigin = (raw: string | null, betId: string | null): TaskOrigin =>
  TASK_ORIGINS.find((o) => o === raw) ?? (betId === null ? "founder" : "work");

/** Queued and running belong to someone; a file saying otherwise (a hand edit, a released assignee) is work nobody has. */
const UNOWNED: TaskState = { kind: "todo" };

export const docToTask = (doc: FrontmatterDoc, companyId: string): Task => {
  const f = doc.fields;
  const m = doc.metadata;
  const prioRaw = optStr(m, "priority");
  const priority = TASK_PRIORITIES.find((p) => p === prioRaw) ?? "medium";
  const body = doc.body.trim();
  const assigneeId = optStr(m, "assigneeId");
  const betId = optStr(m, "betId");
  const state = parseTaskState(m);
  return {
    artifacts: strArray(m, "artifacts"),
    assigneeId,
    attempts: optNum(m, "attempts", 0),
    betId,
    companyId,
    completedAt: nullableNum(m, "completedAt"),
    createdAt: optNum(m, "createdAt", Date.now()),
    description: body === "" ? null : body,
    id: reqStr(f, "slug"),
    origin: parseTaskOrigin(optStr(m, "origin"), betId),
    priority,
    productId: optStr(m, "productId"),
    startedAt: nullableNum(m, "startedAt"),
    state:
      assigneeId === null && (state.kind === "queued" || state.kind === "running")
        ? UNOWNED
        : state,
    title: reqStr(f, "name"),
  };
};
