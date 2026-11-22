import { z } from "zod";
import { BetStateSchema } from "./bets";
import {
  BlockedAskSchema,
  BudgetSchema,
  REST_CAUSES,
  RunOutcomeSchema,
  SpeakerSchema,
  TASK_STATUSES,
} from "./domain";
import { RUNNER_IDS } from "./runners";

/** How much of a room line its chat event carries; the room keeps it whole, since agents act on it. */
export const CHAT_EVENT_TEXT = 400;

const inRun = { employeeId: z.string(), runId: z.string(), taskId: z.string() };
const onTask = { employeeId: z.string(), runId: z.string().optional(), taskId: z.string() };
const byEmployee = { employeeId: z.string() };
const byWhom = { employeeId: z.string().nullable() };
const nobody = {};

const event = <
  K extends string,
  S extends Record<string, z.ZodType>,
  F extends Record<string, z.ZodType>,
>(
  kind: K,
  subject: S,
  fields: F,
) => z.object({ kind: z.literal(kind), ...subject, ...fields });

const ActivityInputSchema = z.discriminatedUnion("kind", [
  event("tool_call", inRun, {
    message: z.string(),
    payload: z.object({ kind: z.string().optional() }),
  }),
  event("message", inRun, { message: z.string() }),
  event("chat", byWhom, {
    message: z.string(),
    payload: z.object({ from: SpeakerSchema, line: z.number(), to: z.string().nullable() }),
  }),
  event("ship", inRun, { message: z.string() }),

  event("status", onTask, { message: z.enum(TASK_STATUSES) }),
  event("run.start", inRun, {}),
  event("run.end", inRun, {
    payload: z.object({
      costUsd: z.number(),
      outcome: RunOutcomeSchema,
      settled: z.enum(TASK_STATUSES).nullable(),
      summary: z.string(),
    }),
  }),
  event("run.ask", inRun, { payload: z.object({ ask: BlockedAskSchema }) }),
  event("task.retry", inRun, {
    payload: z.object({
      attempts: z.number(),
      error: z.string(),
      maxAttempts: z.number(),
      retryAt: z.number(),
    }),
  }),
  event("task.dead", inRun, { payload: z.object({ attempts: z.number(), error: z.string() }) }),

  event("runner.resting", inRun, {
    payload: z.object({
      cause: z.enum(REST_CAUSES),
      error: z.string(),
      runner: z.enum(RUNNER_IDS),
      until: z.number(),
    }),
  }),
  event("org.hired", byEmployee, {
    payload: z.object({ by: z.string(), name: z.string(), title: z.string() }),
  }),
  event("org.released", byEmployee, {
    payload: z.object({ by: z.string(), name: z.string(), reason: z.string() }),
  }),
  event("product.created", byWhom, {
    message: z.string(),
    payload: z.object({ productId: z.string() }),
  }),
  event("product.named", byWhom, {
    message: z.string(),
    payload: z.object({ productId: z.string() }),
  }),
  event("product.killed", byWhom, {
    message: z.string(),
    payload: z.object({ productId: z.string(), reason: z.string() }),
  }),
  event("bet.changed", nobody, {
    message: z.string(),
    payload: z.object({ betId: z.string(), state: BetStateSchema }),
  }),
  event("budget.exhausted", nobody, {
    payload: z.object({ budget: BudgetSchema, spentUsd: z.number() }),
  }),
  event("metrics.pulse", nobody, {
    payload: z.object({ revenue: z.number().nullable(), users: z.number().nullable() }),
  }),
  event("autopilot.changed", nobody, { payload: z.object({ on: z.boolean() }) }),
  event("order.card", nobody, {
    message: z.string(),
    payload: z.object({ open: z.boolean(), taskId: z.string() }),
  }),
]);

/** What a publisher hands in; the publisher stamps the time and the id. */
export type ActivityInput = z.infer<typeof ActivityInputSchema>;

export type ActivityKind = ActivityInput["kind"];

/** An event as published, stamped: what the page hears. */
export const ActivityEventSchema = ActivityInputSchema.and(
  z.object({ createdAt: z.number(), id: z.number() }),
);

export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

/**
 * A row of activity.jsonl: what was published, stamped. Main writes it and never reads it back;
 * the e2e suite reads what a test's runs did from it.
 */
export const PersistedActivitySchema = ActivityInputSchema.and(z.object({ createdAt: z.number() }));

export type PersistedActivity = z.infer<typeof PersistedActivitySchema>;
