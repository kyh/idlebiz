import { z } from "zod";
import {
  ActionAskSchema,
  INTEGRATION_KINDS,
  OrderCardSubjectSchema,
  TASK_ORIGINS,
  TASK_PRIORITIES,
} from "@repo/domain/domain";
import type { BlockedAsk, Task, TaskProvenance, TaskState } from "@repo/domain/domain";
import { parseJson } from "@repo/domain/json";
import { PACKAGE_SCHEMA, decodeDoc, packageFields } from "./frontmatter";
import type { FrontmatterDoc } from "./frontmatter";

const QUESTION_ESCAPE = "[ask] ";
const ACTION_PREFIX = "[action] ";

/** An action's fields, kept as JSON behind its prefix: its instructions and draft are free text. */
const ActionFieldsSchema = ActionAskSchema.omit({ type: true });

// TASK.md stores a human-editable scalar. A question that starts with "[" is escaped so an
// agent's text can never read back as an approval, a connect ask or an action.
const serializeBlockedAsk = (a: BlockedAsk): string => {
  switch (a.type) {
    case "question": {
      return a.question.startsWith("[") ? `${QUESTION_ESCAPE}${a.question}` : a.question;
    }
    case "action": {
      const { action, draft, instructions } = a;
      return `${ACTION_PREFIX}${JSON.stringify({ action, draft, instructions })}`;
    }
    case "approval": {
      return `[approve:${a.rule}] ${a.command}`;
    }
    case "integration": {
      return `[connect:${a.integration}] ${a.reason}`;
    }
    // no default
  }
};

/** An ask as `serializeBlockedAsk` wrote it; a bracketed line it never writes is refused, never read as a question. */
const parseBlockedAsk = (s: string, productId: string | null): BlockedAsk => {
  if (!s.startsWith("[")) {
    return { question: s, type: "question" };
  }
  if (s.startsWith(QUESTION_ESCAPE)) {
    return { question: s.slice(QUESTION_ESCAPE.length), type: "question" };
  }
  if (s.startsWith(ACTION_PREFIX)) {
    return {
      ...ActionFieldsSchema.parse(parseJson(s.slice(ACTION_PREFIX.length))),
      type: "action",
    };
  }
  const approval = /^\[approve:(?<rule>[a-z-]+)\]\s*(?<command>[\s\S]*)$/u.exec(s)?.groups;
  if (approval?.rule !== undefined && approval.command !== undefined) {
    return { command: approval.command.trim(), rule: approval.rule, type: "approval" };
  }
  const connect = /^\[connect:(?<kind>[a-z-]+)\]\s*(?<reason>[\s\S]*)$/u.exec(s)?.groups;
  const integration = INTEGRATION_KINDS.find((k) => k === connect?.kind);
  if (integration === undefined || connect?.reason === undefined) {
    throw new Error(`an ask this build does not write: ${JSON.stringify(s)}`);
  }
  return { integration, productId, reason: connect.reason.trim(), type: "integration" };
};

/** The fields every task carries; a null one gets no line. */
const TaskFieldsSchema = z.object({
  answers: z.string().optional(),
  assigneeId: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  betId: z.string().optional(),
  completedAt: z.number().optional(),
  createdAt: z.number(),
  priority: z.enum(TASK_PRIORITIES),
  productId: z.string().optional(),
});

/** Each state's own fields, flat beside its status line so a TASK.md stays hand-editable. */
const TaskStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("todo") }),
  z.object({
    lastError: z.string().optional(),
    nextAttemptAt: z.number().optional(),
    status: z.literal("queued"),
  }),
  z.object({ runId: z.string(), status: z.literal("running") }),
  z.object({
    askProduct: z.string().optional(),
    blockedQuestion: z.string(),
    status: z.literal("blocked"),
    summary: z.string().optional(),
  }),
  z.object({ status: z.literal("done"), summary: z.string().optional() }),
  z.object({ status: z.literal("superseded"), supersededBy: z.string() }),
  z.object({ status: z.literal("settled") }),
  z.object({ dropReason: z.string(), status: z.literal("dropped") }),
  z.object({ lastError: z.string(), status: z.literal("dead") }),
]);

/** Why a task exists; an order card also names what it is about, as JSON, which dedupe and Done both go by. */
const TaskProvenanceSchema = z.discriminatedUnion("origin", [
  z.object({ origin: z.enum(TASK_ORIGINS).exclude(["order"]) }),
  z.object({
    origin: z.literal("order"),
    subject: z.string().transform(parseJson).pipe(OrderCardSubjectSchema),
  }),
]);

const TaskDocSchema = z.object({
  body: z.string(),
  fields: packageFields("task"),
  metadata: TaskFieldsSchema.and(TaskStatusSchema).and(TaskProvenanceSchema),
});

const statusFields = (st: TaskState): z.input<typeof TaskStatusSchema> => {
  switch (st.kind) {
    case "todo": {
      return { status: "todo" };
    }
    case "queued": {
      return {
        lastError: st.lastError ?? undefined,
        nextAttemptAt: st.nextAttemptAt ?? undefined,
        status: "queued",
      };
    }
    case "running": {
      return { runId: st.runId, status: "running" };
    }
    case "blocked": {
      return {
        askProduct: st.ask.type === "integration" ? (st.ask.productId ?? undefined) : undefined,
        blockedQuestion: serializeBlockedAsk(st.ask),
        status: "blocked",
        summary: st.summary ?? undefined,
      };
    }
    case "done": {
      return { status: "done", summary: st.summary ?? undefined };
    }
    case "superseded": {
      return { status: "superseded", supersededBy: st.by };
    }
    case "settled": {
      return { status: "settled" };
    }
    case "dropped": {
      return { dropReason: st.reason, status: "dropped" };
    }
    case "dead": {
      return { lastError: st.lastError, status: "dead" };
    }
    // no default
  }
};

const provenanceFields = (t: Task): z.input<typeof TaskProvenanceSchema> =>
  t.origin === "order"
    ? { origin: t.origin, subject: JSON.stringify(t.subject) }
    : { origin: t.origin };

const taskProvenance = (m: z.output<typeof TaskProvenanceSchema>): TaskProvenance =>
  m.origin === "order" ? { origin: m.origin, subject: m.subject } : { origin: m.origin };

const taskState = (m: z.output<typeof TaskStatusSchema>): TaskState => {
  switch (m.status) {
    case "todo": {
      return { kind: "todo" };
    }
    case "queued": {
      return {
        kind: "queued",
        lastError: m.lastError ?? null,
        nextAttemptAt: m.nextAttemptAt ?? null,
      };
    }
    case "running": {
      return { kind: "running", runId: m.runId };
    }
    case "blocked": {
      return {
        ask: parseBlockedAsk(m.blockedQuestion, m.askProduct ?? null),
        kind: "blocked",
        summary: m.summary ?? null,
      };
    }
    case "done": {
      return { kind: "done", summary: m.summary ?? null };
    }
    case "superseded": {
      return { by: m.supersededBy, kind: "superseded" };
    }
    case "settled": {
      return { kind: "settled" };
    }
    case "dropped": {
      return { kind: "dropped", reason: m.dropReason };
    }
    case "dead": {
      return { kind: "dead", lastError: m.lastError };
    }
    // no default
  }
};

export const taskToDoc = (t: Task): z.input<typeof TaskDocSchema> => ({
  body: t.description ? `${t.description}\n` : "",
  fields: { kind: "task", name: t.title, schema: PACKAGE_SCHEMA, slug: t.id },
  metadata: {
    answers: t.answers ?? undefined,
    assigneeId: t.assigneeId ?? undefined,
    attempts: t.attempts,
    betId: t.betId ?? undefined,
    completedAt: t.completedAt ?? undefined,
    createdAt: t.createdAt,
    priority: t.priority,
    productId: t.productId ?? undefined,
    ...statusFields(t.state),
    ...provenanceFields(t),
  },
});

export const docToTask = (doc: FrontmatterDoc): Task => {
  const { body, fields, metadata: m } = decodeDoc(TaskDocSchema, doc);
  const description = body.trim();
  return {
    answers: m.answers ?? null,
    assigneeId: m.assigneeId ?? null,
    attempts: m.attempts,
    betId: m.betId ?? null,
    completedAt: m.completedAt ?? null,
    createdAt: m.createdAt,
    description: description === "" ? null : description,
    id: fields.slug,
    priority: m.priority,
    productId: m.productId ?? null,
    state: taskState(m),
    title: fields.name,
    ...taskProvenance(m),
  };
};
