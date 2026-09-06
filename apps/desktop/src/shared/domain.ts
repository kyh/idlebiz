// Shared by main and renderer. Ids are agentcompanies/v1 slugs matching package folders.
export type AgentRunner = import("@repo/agent-driver/runner").RunnerId;

import { z } from "zod";

/** Hard ceiling on team size — the LLM staffs freely underneath it. */
export const DEFAULT_MAX_AGENTS = 12;

/** The founder's look when none was chosen: pins a bundled sheet (see compositor). */
export const DEFAULT_FOUNDER_SEED = "founder-player-001";

/** A new employee's look: a seed the compositor maps to a bundled sheet, unique per hire. */
export const spriteSeedFor = (role: string, name: string, salt = ""): string =>
  `${role}-${name}-${Date.now().toString(36)}${salt}`;

export const INTEGRATION_KINDS = ["vercel", "stripe"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const INTEGRATION_LABELS = {
  vercel: "Vercel",
  stripe: "Stripe",
} satisfies Record<IntegrationKind, string>;

export const BlockedAskSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("question"), question: z.string() }),
  z.object({
    type: z.literal("integration"),
    integration: z.enum(INTEGRATION_KINDS),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("approval"),
    command: z.string(),
    // Saved asks retain identifiers even after the runtime policy retires a rule.
    rule: z.string().regex(/^[a-z-]+$/),
  }),
]);
export type BlockedAsk = z.infer<typeof BlockedAskSchema>;

// TASK.md stores a human-editable scalar; in memory, asks use the typed union.
export function serializeBlockedAsk(a: BlockedAsk): string {
  if (a.type === "question") return a.question;
  if (a.type === "approval") return `[approve:${a.rule}] ${a.command}`;
  return `[connect:${a.integration}] ${a.reason}`;
}

export function parseBlockedAsk(s: string): BlockedAsk {
  const approval = /^\[approve(?::([a-z-]+))?\]\s*([\s\S]*)$/.exec(s);
  if (approval) {
    const command = (approval[2] ?? "").trim();
    const rule = approval[1] ?? "write-outside";
    return { type: "approval", command, rule };
  }
  const m = /^\[connect:([a-z]+)\]\s*([\s\S]*)$/.exec(s);
  const integration = INTEGRATION_KINDS.find((k) => k === m?.[1]);
  if (!integration) return { type: "question", question: s };
  return { type: "integration", integration, reason: (m?.[2] ?? "").trim() };
}

/**
 * Resolve `@token` mentions against the roster: employee slug match first,
 * then exact first-name token (case-insensitive). Whole-token matching only —
 * `@sam` never wakes Samantha. Returns matched employee ids, deduped.
 */
export function resolveMentions(
  text: string,
  roster: readonly { id: string; name: string }[],
): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/@([\w-]+)/g)) {
    const token = (m[1] ?? "").toLowerCase();
    if (!token) continue;
    const bySlug = roster.find((e) => e.id.toLowerCase() === token);
    const byFirst = roster.filter((e) => e.name.split(/\s+/)[0]?.toLowerCase() === token);
    if (bySlug) ids.add(bySlug.id);
    else for (const e of byFirst) ids.add(e.id);
  }
  return [...ids];
}

/** dead: failed MAX_TASK_ATTEMPTS times, no longer auto-retried. */
export const TASK_STATUSES = ["todo", "queued", "running", "blocked", "done", "dead"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
/** Whether a run is in flight for them. Held in memory by the scheduler, never on disk. */
type EmployeeStatus = "idle" | "working";

/** How a run ended, as the scheduler settles the task and the office hears about it. */
export const RunOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("done") }),
  z.object({ kind: z.literal("blocked"), ask: BlockedAskSchema }),
  // the CLI hit its usage limit: park until `until` without burning an attempt
  z.object({ kind: z.literal("resting"), until: z.number(), error: z.string() }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** How many times a task may run before it is dead-lettered. */
export const MAX_TASK_ATTEMPTS = 5;
const RETRY_BASE_MS = 15_000;
const RETRY_CAP_MS = 10 * 60_000;

/** Exponential backoff for the Nth failed attempt (1-based), capped. */
function retryDelayMs(attempt: number): number {
  const d = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(d, RETRY_CAP_MS);
}

export type FailureVerdict =
  | { kind: "retry"; attempts: number; retryAt: number }
  | { kind: "dead"; attempts: number };

export function afterFailure(attemptsSoFar: number, now: number): FailureVerdict {
  const attempts = attemptsSoFar + 1;
  return attempts >= MAX_TASK_ATTEMPTS
    ? { kind: "dead", attempts }
    : { kind: "retry", attempts, retryAt: now + retryDelayMs(attempts) };
}

export const BUSINESS_TYPE_IDS = ["software", "game-studio", "vc", "ecommerce", "custom"] as const;
export type BusinessTypeId = (typeof BUSINESS_TYPE_IDS)[number];

export interface BusinessType {
  id: BusinessTypeId;
  label: string;
  pitchPlaceholder: string;
}

export const BUSINESS_TYPES: readonly BusinessType[] = [
  {
    id: "software",
    label: "Software company",
    pitchPlaceholder: "A delightful to-do app that makes planning feel effortless.",
  },
  {
    id: "game-studio",
    label: "Game studio",
    pitchPlaceholder: "A cozy pixel-art farming roguelike playable in the browser.",
  },
  {
    id: "vc",
    label: "Venture capital firm",
    pitchPlaceholder:
      "A micro-VC that sources and writes investment memos on early-stage AI startups.",
  },
  {
    id: "ecommerce",
    label: "E-commerce business",
    pitchPlaceholder: "An online store selling artist-designed enamel pins.",
  },
  {
    id: "custom",
    label: "Something else…",
    pitchPlaceholder: "A daily AI-curated newsletter for indie hackers.",
  },
];

export function businessTypeById(id: BusinessTypeId): BusinessType {
  const found = BUSINESS_TYPES.find((b) => b.id === id);
  if (!found) throw new Error(`unknown business type ${id}`);
  return found;
}

/** Founder's AI spending budget. Infinite IS the off state — no third mode. */
export const BudgetSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("infinite") }),
  z.object({ mode: z.literal("capped"), capUsd: z.number().nonnegative() }),
]);
export type Budget = z.infer<typeof BudgetSchema>;

export function isOutOfBudget(co: Company): boolean {
  return co.budget.mode === "capped" && co.spentUsd >= co.budget.capUsd;
}

export interface Company {
  id: string;
  name: string;
  mission: string;
  businessType: BusinessTypeId;
  workspaceDir: string;
  founderName: string;
  founderSpriteSeed: string;
  autopilot: boolean; // when true, idle employees self-direct work (idle-game loop)
  maxAgents: number; // seat cap — the lead hires/releases freely below it
  /** The employee who coordinates: hires, releases, delegates. Null until someone is hired. */
  leaderId: string | null;
  ships: number; // units of work the team has shipped
  revenueUsd: number | null; // REAL revenue (Stripe); null until a source is connected
  users: number | null; // REAL users (analytics); null until a source is connected
  budget: Budget;
  spentUsd: number; // lifetime real token spend (USD)
  createdAt: number;
}

export interface Employee {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string;
  persona: string; // system-prompt flavor for the agent
  runner: AgentRunner;
  sessionId: string | null;
  spriteSeed: string; // deterministic sprite + portrait
  deskIndex: number; // which desk slot in the office
  status: EmployeeStatus;
  createdAt: number;
}

/** The Vercel project a product deploys to; the token is the founder's, one per company. */
export interface VercelBinding {
  projectId: string;
  projectName: string;
  teamId: string | null;
}

/** The first product shares the company workspace; later products have their own. */
export interface Product {
  id: string;
  companyId: string;
  name: string;
  description: string;
  workspaceDir: string;
  ships: number;
  /** When work for it last shipped; autopilot turns to the product waited on longest. */
  lastShipAt: number | null;
  users: number | null; // REAL visitors of its deploy (Vercel Web Analytics); null until bound
  vercel: VercelBinding | null;
  createdAt: number;
}

/** What a task's status says about its assignee: working while a run is in flight, idle otherwise. */
export const employeeStatusOf = (status: TaskStatus): EmployeeStatus =>
  status === "running" ? "working" : "idle";

export interface TeamMessage {
  id?: number;
  companyId: string;
  fromEmployeeId: string | null; // null = system/founder
  text: string;
  createdAt: number;
}

export type TaskState =
  | { kind: "todo" }
  | {
      kind: "queued";
      /** Earliest time a backoff retry may start; null runs at the next tick. */
      nextAttemptAt: number | null;
      /** Why the previous run failed, when this is a retry. */
      lastError: string | null;
    }
  | { kind: "running"; runId: string }
  | { kind: "blocked"; ask: BlockedAsk; summary: string | null }
  | { kind: "done"; summary: string | null }
  | { kind: "dead"; lastError: string };

// the state kinds and the status vocabulary (TASK.md, the IPC filter, status events) are one set
type _AssertStatesAreStatuses = TaskState["kind"] extends TaskStatus ? true : never;
type _AssertStatusesAreStates = TaskStatus extends TaskState["kind"] ? true : never;
const taskStatesInSync: _AssertStatesAreStatuses & _AssertStatusesAreStates = true;
void taskStatesInSync;

/** A task known to be in one state, so its fields need no second check. */
export type TaskIn<K extends TaskStatus> = Task & { state: Extract<TaskState, { kind: K }> };

/** Narrow a task to one state: `tasks.filter(taskIn("blocked"))` gives every ask, typed. */
export const taskIn =
  <K extends TaskStatus>(kind: K) =>
  (t: Task): t is TaskIn<K> =>
    t.state.kind === kind;

export interface Task {
  id: string;
  companyId: string;
  /** The product this work is for; null is company-level work (a review, a routine). */
  productId: string | null;
  title: string;
  description: string | null;
  state: TaskState;
  priority: TaskPriority;
  assigneeId: string | null;
  artifacts: string[]; // file paths the agent reported
  /** Failed runs so far — drives retry backoff and the dead letter, across states. */
  attempts: number;
  createdAt: number;
  /** When its latest run began. */
  startedAt: number | null;
  /** When it last reached done, blocked or dead. */
  completedAt: number | null;
}

/** A recurring instruction that creates a task at each interval. */
export interface Routine {
  id: string;
  companyId: string;
  name: string;
  instruction: string;
  intervalHours: number;
  role: string | null; // preferred assignee role (substring match), else anyone idle
  lastRunAt: number | null;
}
