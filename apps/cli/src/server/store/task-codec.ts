import { unreachable } from "@repo/domain/errors";
import { z } from "zod";
import {
  ActionAskSchema,
  INTEGRATION_KINDS,
  OrderCardSubjectSchema,
  TASK_ORIGINS,
  TASK_PRIORITIES,
} from "@repo/domain/domain";
import type { BlockedAsk, Task, TaskProvenance, TaskState } from "@repo/domain/domain";
import { HOLD_RULE_IDS } from "@repo/domain/hold-rules";
import { parseJson } from "@repo/domain/json";
import { PACKAGE_SCHEMA, decodeDoc, packageFields } from "./frontmatter";
import type { FrontmatterDoc } from "./frontmatter";

const QUESTION_ESCAPE = "[ask] ";
const ACTION_PREFIX = "[action] ";

const ActionFieldsSchema = ActionAskSchema.omit({ type: true });

const serializeBlockedAsk = (a: BlockedAsk) => {
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

    default: {
      return unreachable(a);
    }
  }
};

const parseBlockedAsk = (s: string, productId: string | null) => {
  if (!s.startsWith("[")) {
    return { question: s, type: "question" } satisfies BlockedAsk;
  }

  if (s.startsWith(QUESTION_ESCAPE)) {
    return { question: s.slice(QUESTION_ESCAPE.length), type: "question" } satisfies BlockedAsk;
  }

  if (s.startsWith(ACTION_PREFIX)) {
    return {
      ...ActionFieldsSchema.parse(parseJson(s.slice(ACTION_PREFIX.length))),
      type: "action",
    } satisfies BlockedAsk;
  }

  const approval = /^\[approve:(?<rule>[a-z-]+)\]\s*(?<command>[\s\S]*)$/u.exec(s)?.groups;
  const rule = HOLD_RULE_IDS.find((id) => id === approval?.rule);

  if (rule !== undefined && approval?.command !== undefined) {
    return { command: approval.command.trim(), rule, type: "approval" } satisfies BlockedAsk;
  }

  const connect = /^\[connect:(?<kind>[a-z-]+)\]\s*(?<reason>[\s\S]*)$/u.exec(s)?.groups;
  const integration = INTEGRATION_KINDS.find((k) => k === connect?.kind);

  if (integration === undefined || connect?.reason === undefined) {
    throw new Error(`an ask this build does not write: ${JSON.stringify(s)}`);
  }

  return {
    integration,
    productId,
    reason: connect.reason.trim(),
    type: "integration",
  } satisfies BlockedAsk;
};

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

const statusFields = (st: TaskState) => {
  switch (st.kind) {
    case "todo": {
      return { status: "todo" } satisfies z.input<typeof TaskStatusSchema>;
    }

    case "queued": {
      return {
        lastError: st.lastError ?? undefined,
        nextAttemptAt: st.nextAttemptAt ?? undefined,
        status: "queued",
      } satisfies z.input<typeof TaskStatusSchema>;
    }

    case "running": {
      return { runId: st.runId, status: "running" } satisfies z.input<typeof TaskStatusSchema>;
    }

    case "blocked": {
      return {
        askProduct: st.ask.type === "integration" ? (st.ask.productId ?? undefined) : undefined,
        blockedQuestion: serializeBlockedAsk(st.ask),
        status: "blocked",
        summary: st.summary ?? undefined,
      } satisfies z.input<typeof TaskStatusSchema>;
    }

    case "done": {
      return { status: "done", summary: st.summary ?? undefined } satisfies z.input<
        typeof TaskStatusSchema
      >;
    }

    case "superseded": {
      return { status: "superseded", supersededBy: st.by } satisfies z.input<
        typeof TaskStatusSchema
      >;
    }

    case "settled": {
      return { status: "settled" } satisfies z.input<typeof TaskStatusSchema>;
    }

    case "dropped": {
      return { dropReason: st.reason, status: "dropped" } satisfies z.input<
        typeof TaskStatusSchema
      >;
    }

    case "dead": {
      return { lastError: st.lastError, status: "dead" } satisfies z.input<typeof TaskStatusSchema>;
    }

    default: {
      return unreachable(st);
    }
  }
};

const provenanceFields = (t: Task) =>
  (t.origin === "order"
    ? { origin: t.origin, subject: JSON.stringify(t.subject) }
    : { origin: t.origin }) satisfies z.input<typeof TaskProvenanceSchema>;

const taskProvenance = (m: z.output<typeof TaskProvenanceSchema>) =>
  (m.origin === "order"
    ? { origin: m.origin, subject: m.subject }
    : { origin: m.origin }) satisfies TaskProvenance;

const taskState = (m: z.output<typeof TaskStatusSchema>) => {
  switch (m.status) {
    case "todo": {
      return { kind: "todo" } satisfies TaskState;
    }

    case "queued": {
      return {
        kind: "queued",
        lastError: m.lastError ?? null,
        nextAttemptAt: m.nextAttemptAt ?? null,
      } satisfies TaskState;
    }

    case "running": {
      return { kind: "running", runId: m.runId } satisfies TaskState;
    }

    case "blocked": {
      return {
        ask: parseBlockedAsk(m.blockedQuestion, m.askProduct ?? null),
        kind: "blocked",
        summary: m.summary ?? null,
      } satisfies TaskState;
    }

    case "done": {
      return { kind: "done", summary: m.summary ?? null } satisfies TaskState;
    }

    case "superseded": {
      return { by: m.supersededBy, kind: "superseded" } satisfies TaskState;
    }

    case "settled": {
      return { kind: "settled" } satisfies TaskState;
    }

    case "dropped": {
      return { kind: "dropped", reason: m.dropReason } satisfies TaskState;
    }

    case "dead": {
      return { kind: "dead", lastError: m.lastError } satisfies TaskState;
    }

    default: {
      return unreachable(m);
    }
  }
};

export const taskToDoc = (t: Task) =>
  ({
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
  }) satisfies z.input<typeof TaskDocSchema>;

export const docToTask = (doc: FrontmatterDoc) => {
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
  } satisfies Task;
};
