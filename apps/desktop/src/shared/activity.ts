import { z } from "zod";
import { RUNNER_IDS } from "@repo/agent-driver/runner";
import { BetStateSchema } from "./bets";
import {
  BlockedAskSchema,
  BudgetSchema,
  RunOutcomeSchema,
  SpeakerSchema,
  TASK_STATUSES,
} from "./domain";

// main/activity.ts publishes this union and persists it as activity.jsonl rows.

/** A step in one employee's run on one task. */
const inRun = { employeeId: z.string(), runId: z.string(), taskId: z.string() };
/** A task moving for its assignee; one just queued has no run yet. */
const onTask = { employeeId: z.string(), runId: z.string().optional(), taskId: z.string() };
/** Something that happened to one employee. */
const byEmployee = { employeeId: z.string() };
/** Done by an employee, or by the founder or the system when null. */
const byWhom = { employeeId: z.string().nullable() };
/** Company-wide: it names nobody. */
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
  /**
   * ACP `kind` is what the call does (read, edit, execute…); the office poses on it. The
   * call's input stays out: it carries whole file bodies and inlined secrets, and each CLI
   * keeps its own transcript.
   */
  event("tool_call", inRun, {
    message: z.string(),
    payload: z.object({ kind: z.string().optional() }),
  }),
  /** One assistant message, flushed at a tool call or the end of the turn. */
  event("message", inRun, { message: z.string() }),
  /** A line in the team room. `to` names the teammate it was handed to, if any. */
  event("chat", byWhom, {
    message: z.string(),
    payload: z.object({ from: SpeakerSchema, to: z.string().nullable() }),
  }),
  /** A completed task's summary — the real counter behind the product version. */
  event("ship", inRun, { message: z.string() }),

  event("status", onTask, { message: z.enum(TASK_STATUSES) }),
  event("run.start", inRun, {}),
  event("run.end", inRun, {
    payload: z.object({
      /** What the run cost, as its CLI billed it: the number the budget moved by. Rows from before it was recorded have none. */
      costUsd: z.number().optional(),
      outcome: RunOutcomeSchema,
      summary: z.string(),
    }),
  }),
  /** Raised the moment the employee asks, not when the run settles. */
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
    payload: z.object({ runner: z.enum(RUNNER_IDS), until: z.number() }),
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
  event("product.killed", byWhom, {
    message: z.string(),
    payload: z.object({ productId: z.string(), reason: z.string() }),
  }),
  /** A bet opened or changed state; the message is its title. */
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
]);

/** What a publisher hands in; the publisher stamps the time and the id. */
export type ActivityInput = z.infer<typeof ActivityInputSchema>;
export type ActivityKind = ActivityInput["kind"];

export type ActivityEvent = ActivityInput & { id: number; createdAt: number };

/** A row of activity.jsonl: what was published, stamped. Written, never read back. */
export type PersistedActivity = ActivityInput & { createdAt: number };
