import { z } from "zod";
import type { RunnerId } from "@repo/agent-driver/runner";

// Shared by main and renderer. Ids are agentcompanies/v1 slugs matching package folders.
export type AgentRunner = RunnerId;

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
  stripe: "Stripe",
  vercel: "Vercel",
} satisfies Record<IntegrationKind, string>;

export const BlockedAskSchema = z.discriminatedUnion("type", [
  z.object({ question: z.string(), type: z.literal("question") }),
  z.object({
    integration: z.enum(INTEGRATION_KINDS),
    reason: z.string(),
    type: z.literal("integration"),
  }),
  z.object({
    command: z.string(),
    // Saved asks retain identifiers even after the runtime policy retires a rule.
    rule: z.string().regex(/^[a-z-]+$/u),
    type: z.literal("approval"),
  }),
]);
export type BlockedAsk = z.infer<typeof BlockedAskSchema>;

// TASK.md stores a human-editable scalar; in memory, asks use the typed union.
export const serializeBlockedAsk = (a: BlockedAsk): string => {
  if (a.type === "question") {
    return a.question;
  }
  if (a.type === "approval") {
    return `[approve:${a.rule}] ${a.command}`;
  }
  return `[connect:${a.integration}] ${a.reason}`;
};

export const parseBlockedAsk = (s: string): BlockedAsk => {
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

/**
 * Resolve `@token` mentions against the roster: employee slug match first,
 * then exact first-name token (case-insensitive). Whole-token matching only —
 * `@sam` never wakes Samantha. Returns matched employee ids, deduped.
 */
export const resolveMentions = (
  text: string,
  roster: readonly { id: string; name: string }[],
): string[] => {
  const ids = new Set<string>();
  for (const m of text.matchAll(/@(?<token>[\w-]+)/gu)) {
    const token = (m.groups?.token ?? "").toLowerCase();
    if (!token) {
      continue;
    }
    const bySlug = roster.find((e) => e.id.toLowerCase() === token);
    const byFirst = roster.filter((e) => e.name.split(/\s+/u)[0]?.toLowerCase() === token);
    if (bySlug) {
      ids.add(bySlug.id);
    } else {
      for (const e of byFirst) {
        ids.add(e.id);
      }
    }
  }
  return [...ids];
};

/** dead: failed MAX_TASK_ATTEMPTS times, no longer auto-retried. */
export const TASK_STATUSES = ["todo", "queued", "running", "blocked", "done", "dead"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
/** Whether a run is in flight for them. Held in memory by the scheduler, never on disk. */
export type EmployeeStatus = "idle" | "working";

/** How a run ended, as the scheduler settles the task and the office hears about it. */
export const RunOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("done") }),
  z.object({ ask: BlockedAskSchema, kind: z.literal("blocked") }),
  // the CLI hit its usage limit: park until `until` without burning an attempt
  z.object({ error: z.string(), kind: z.literal("resting"), until: z.number() }),
  z.object({ error: z.string(), kind: z.literal("failed") }),
]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** How many times a task may run before it is dead-lettered. */
export const MAX_TASK_ATTEMPTS = 5;
const RETRY_BASE_MS = 15_000;
const RETRY_CAP_MS = 10 * 60_000;

/** Exponential backoff for the Nth failed attempt (1-based), capped. */
const retryDelayMs = (attempt: number): number => {
  const d = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(d, RETRY_CAP_MS);
};

export type FailureVerdict =
  | { kind: "retry"; attempts: number; retryAt: number }
  | { kind: "dead"; attempts: number };

export const afterFailure = (attemptsSoFar: number, now: number): FailureVerdict => {
  const attempts = attemptsSoFar + 1;
  return attempts >= MAX_TASK_ATTEMPTS
    ? { attempts, kind: "dead" }
    : { attempts, kind: "retry", retryAt: now + retryDelayMs(attempts) };
};

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

export const businessTypeById = (id: BusinessTypeId): BusinessType => {
  const found = BUSINESS_TYPES.find((b) => b.id === id);
  if (!found) {
    throw new Error(`unknown business type ${id}`);
  }
  return found;
};

/** Founder's AI spending budget. Infinite IS the off state — no third mode. */
export const BudgetSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("infinite") }),
  z.object({ capUsd: z.number().nonnegative(), mode: z.literal("capped") }),
]);
export type Budget = z.infer<typeof BudgetSchema>;

export const isOutOfBudget = (co: Company): boolean =>
  co.budget.mode === "capped" && co.spentUsd >= co.budget.capUsd;

export interface Company {
  id: string;
  name: string;
  mission: string;
  businessType: BusinessTypeId;
  workspaceDir: string;
  founderName: string;
  founderSpriteSeed: string;
  /** when true, idle employees self-direct work (idle-game loop) */
  autopilot: boolean;
  /** seat cap — the lead hires/releases freely below it */
  maxAgents: number;
  /** The employee who coordinates: hires, releases, delegates. Null until someone is hired. */
  leaderId: string | null;
  /** units of work the team has shipped */
  ships: number;
  /** REAL revenue (Stripe); null until a source is connected */
  revenueUsd: number | null;
  /** REAL users (analytics); null until a source is connected */
  users: number | null;
  budget: Budget;
  /** lifetime real token spend (USD) */
  spentUsd: number;
  createdAt: number;
}

/** Where the real numbers stood when an employee's run ended. */
export const RunMetricsSchema = z.object({
  at: z.number(),
  revenueUsd: z.number().nullable(),
  users: z.number().nullable(),
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

export interface Employee {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string;
  /** system-prompt flavor for the agent */
  persona: string;
  runner: AgentRunner;
  sessionId: string | null;
  /** deterministic sprite + portrait */
  spriteSeed: string;
  /** which desk slot in the office */
  deskIndex: number;
  /** The numbers as their last run ended, so the next brief can say what moved. Null before a first run. */
  lastRunMetrics: RunMetrics | null;
  status: EmployeeStatus;
  createdAt: number;
}

/**
 * Who coordinates: the first hire. The cast is asked to list first the one who
 * runs the company, and when a lead leaves, the longest-serving teammate takes
 * over. Titles are free text a model wrote — "Product Designer", "Art Director",
 * "Growth Lead" all read like leadership and none of them is — so they are never
 * guessed from.
 */
export const leadOf = (employees: readonly Pick<Employee, "id">[]): string | null =>
  employees[0]?.id ?? null;

/** Whether someone answers to a role named loosely: "market" finds the Growth & Marketing Lead, "engineer" the Founding Engineer. */
export const hasRole =
  (want: string) =>
  (employee: Pick<Employee, "role" | "title">): boolean =>
    `${employee.role} ${employee.title}`.toLowerCase().includes(want.trim().toLowerCase());

export const isLead = (
  company: Pick<Company, "leaderId">,
  employee: Pick<Employee, "id">,
): boolean => company.leaderId === employee.id;

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
  /** REAL visitors of its deploy (Vercel Web Analytics); null until bound */
  users: number | null;
  /** REAL revenue from Stripe charges tagged `metadata[product]=<id>`; null until Stripe is connected */
  revenueUsd: number | null;
  vercel: VercelBinding | null;
  createdAt: number;
}

/** What a task's status says about its assignee: working while a run is in flight, idle otherwise. */
export const employeeStatusOf = (status: TaskStatus): EmployeeStatus =>
  status === "running" ? "working" : "idle";

export interface TeamMessage {
  id?: number;
  companyId: string;
  /** null = system/founder */
  fromEmployeeId: string | null;
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
  /** The bet this work spends against; null is work no bet pays for (a founder ping, a review). */
  betId: string | null;
  title: string;
  description: string | null;
  state: TaskState;
  priority: TaskPriority;
  assigneeId: string | null;
  /** file paths the agent reported */
  artifacts: string[];
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
  /** preferred assignee role (substring match), else anyone idle */
  role: string | null;
  lastRunAt: number | null;
}

/**
 * A routine that has never run waits out its first interval from the company's
 * founding: due at once, every routine fires on the first tick, ahead of the
 * lead's first bet and before there is anything to review.
 */
export const isRoutineDue = (routine: Routine, foundedAt: number, now: number): boolean =>
  now - (routine.lastRunAt ?? foundedAt) >= routine.intervalHours * 3_600_000;

/** Streamed steps of the workforce setup flow (CLI detect/install/login). */
export type AuthFlowEvent =
  | { type: "url"; url: string }
  | { type: "progress"; message: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** runner → epoch its usage limit lifts, for every runner currently parked. */
export type RestingRunners = Partial<Record<AgentRunner, number>>;

/** A package on disk the store could not read at boot, and why. */
export interface LoadSkip {
  kind: "company" | "employee" | "task" | "routine" | "product" | "bet" | "team";
  path: string;
  error: string;
}

/** What boot found under ~/.idlebiz: how many companies loaded, and what it had to leave out. */
export interface LoadReport {
  companies: number;
  skipped: LoadSkip[];
}

/** One thing the founder can ask an employee from the battle box: the label shown, the brief sent. */
export interface ChatOption {
  label: string;
  instruction: string;
}

/** A composited character: base64 PNG data URLs ready for Phaser/<img>. */
export interface CharacterAssets {
  /** 192x384 PNG, 32x64 frames: walk down/left/right/up, sit-left, sit-right */
  walkSheetDataUrl: string;
  /** 44x44 PNG: the drawn head-and-shoulders bust */
  bustDataUrl: string;
}
