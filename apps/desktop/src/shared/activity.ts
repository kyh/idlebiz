import { z } from "zod";
import { RUNNER_IDS } from "@repo/agent-driver/runner";
import { BlockedAskSchema, BudgetSchema, RunOutcomeSchema, TASK_STATUSES } from "./domain";

// ---------------------------------------------------------------------------
// The activity stream: everything the office says happened, as one typed union.
//
// Main publishes it (see main/activity.ts), the renderer store, the scene and
// the feeds switch on `kind`, and activity.jsonl persists it one row per line.
// The same schema reads the log back, so a consumer never re-parses a payload:
// what an event carries is settled here, once.
// ---------------------------------------------------------------------------

/** What an event is about. Every field is optional: a budget halt names nobody. */
const subject = z.object({
  runId: z.string().nullish(),
  taskId: z.string().nullish(),
  employeeId: z.string().nullish(),
});

/** One event: its subject, the discriminant, and whatever that kind carries. */
const event = <K extends string, F extends Record<string, z.ZodType>>(kind: K, fields: F) =>
  subject.extend({ kind: z.literal(kind), ...fields });

const ActivityInputSchema = z.discriminatedUnion("kind", [
  // ---- what an employee did, streamed from the run ----
  /** ACP `kind` is what the call does (read, edit, execute…); the office poses on it. */
  event("tool_call", {
    message: z.string(),
    payload: z.object({ kind: z.string().optional(), args: z.unknown() }),
  }),
  /** One assistant message, flushed at a tool call or the end of the turn. */
  event("message", { message: z.string() }),
  /** A line in the team room. `to` names the teammate it was handed to, if any. */
  event("chat", { message: z.string(), payload: z.object({ to: z.string().nullable() }) }),
  /** A completed task's summary — the real counter behind the product version. */
  event("ship", { message: z.string() }),

  // ---- the task lifecycle ----
  event("status", { message: z.enum(TASK_STATUSES) }),
  event("run.start", {}),
  event("run.end", { payload: z.object({ summary: z.string(), outcome: RunOutcomeSchema }) }),
  /** Raised the moment the employee asks, not when the run settles. */
  event("run.ask", { payload: z.object({ ask: BlockedAskSchema }) }),
  event("task.retry", {
    payload: z.object({
      attempts: z.number(),
      maxAttempts: z.number(),
      retryAt: z.number(),
      error: z.string(),
    }),
  }),
  event("task.dead", { payload: z.object({ attempts: z.number(), error: z.string() }) }),

  // ---- the office ----
  event("runner.resting", { payload: z.object({ runner: z.enum(RUNNER_IDS), until: z.number() }) }),
  event("org.hired", {
    payload: z.object({ by: z.string(), name: z.string(), title: z.string() }),
  }),
  event("org.released", {
    payload: z.object({ by: z.string(), name: z.string(), reason: z.string() }),
  }),
  event("budget.exhausted", { payload: z.object({ spentUsd: z.number(), budget: BudgetSchema }) }),
  event("metrics.pulse", {
    payload: z.object({ users: z.number().nullable(), revenue: z.number().nullable() }),
  }),
  event("autopilot.changed", { payload: z.object({ on: z.boolean() }) }),
]);

/** What a publisher hands in; the publisher stamps the time and the id. */
export type ActivityInput = z.infer<typeof ActivityInputSchema>;
export type ActivityKind = ActivityInput["kind"];

/** Every event of one kind, with the stamped fields. */
export type ActivityEvent = ActivityInput & { id: number; createdAt: number };

/**
 * One activity.jsonl row. Rows written before the lifecycle events had kinds of
 * their own carry `kind: "lifecycle"` and the event name in `message`; they are
 * lifted on the way in. Anything the schema cannot place is dropped by the reader.
 */
const legacyLifecycleRow = z.object({ kind: z.literal("lifecycle"), message: z.string() }).loose();

export const PersistedActivitySchema = z.preprocess(
  (row) => {
    const legacy = legacyLifecycleRow.safeParse(row);
    if (!legacy.success) return row;
    const { message, ...rest } = legacy.data;
    return { ...rest, kind: message };
  },
  z.intersection(ActivityInputSchema, z.object({ createdAt: z.number() })),
);
export type PersistedActivity = z.infer<typeof PersistedActivitySchema>;
