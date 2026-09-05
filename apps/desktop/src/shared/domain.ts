// Domain shapes shared across main (control plane) and renderer (game UI).
// Types and the zod schemas they are inferred from — safe to import anywhere.
//
// Identity: ids ARE agentcompanies/v1 slugs (URL-safe, human-readable). A
// company's id is its folder name under ~/.idlebiz; an employee's id is its
// folder name under agents/; a task's id is its folder name under tasks/.

/**
 * Which coding-agent CLI powers an employee. Employees run on the player's
 * own installed CLIs — a mixed roster is normal. The union is owned by
 * @repo/agent-driver (type-only re-export keeps this module renderer-safe);
 * use `isRunnerId` from the package where a runtime guard is needed.
 */
export type AgentRunner = import("@repo/agent-driver/runner").RunnerId;

import { z } from "zod";
import { RULE_IDS, classifyCommand, type RuleId } from "./command-policy";

/** Hard ceiling on team size — the LLM staffs freely underneath it. */
export const DEFAULT_MAX_AGENTS = 12;

/** The founder's look when none was chosen: pins a bundled sheet (see compositor). */
export const DEFAULT_FOUNDER_SEED = "founder-player-001";

/** A new employee's look: a seed the compositor maps to a bundled sheet, unique per hire. */
export const spriteSeedFor = (role: string, name: string, salt = ""): string =>
  `${role}-${name}-${Date.now().toString(36)}${salt}`;

// ---- blocked asks ------------------------------------------------------------
// Why a task is waiting on the founder. Structured end-to-end: a free-text
// question gets an answer box; an integration request renders a [Connect]
// button and the task auto-resumes once the founder connects.

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
  z.object({ type: z.literal("approval"), command: z.string(), rule: z.enum(RULE_IDS) }),
]);
export type BlockedAsk = z.infer<typeof BlockedAskSchema>;

// TASK.md keeps a single human-editable scalar; the marker syntax exists ONLY
// at this persistence boundary — everything in memory is the typed union.
export function serializeBlockedAsk(a: BlockedAsk): string {
  if (a.type === "question") return a.question;
  if (a.type === "approval") return `[approve:${a.rule}] ${a.command}`;
  return `[connect:${a.integration}] ${a.reason}`;
}

/** The rule that would hold a command today — for an ask persisted before rules had ids. */
function ruleFor(command: string): RuleId {
  const verdict = classifyCommand(command);
  return verdict.decision === "ask" ? verdict.rule.id : "write-outside";
}

export function parseBlockedAsk(s: string): BlockedAsk {
  const approval = /^\[approve(?::([a-z-]+))?\]\s*([\s\S]*)$/.exec(s);
  if (approval) {
    const command = (approval[2] ?? "").trim();
    const rule = RULE_IDS.find((id) => id === approval[1]) ?? ruleFor(command);
    return { type: "approval", command, rule };
  }
  const m = /^\[connect:([a-z]+)\]\s*([\s\S]*)$/.exec(s);
  const integration = INTEGRATION_KINDS.find((k) => k === m?.[1]);
  if (!integration) return { type: "question", question: s };
  return { type: "integration", integration, reason: (m?.[2] ?? "").trim() };
}

// ---- team-room mentions --------------------------------------------------------

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

// ---- queue reliability (TinyAGI-style retry/dead-letter) --------------------

/** How many times a task may run before it is dead-lettered. */
export const MAX_TASK_ATTEMPTS = 5;
const RETRY_BASE_MS = 15_000;
const RETRY_CAP_MS = 10 * 60_000;

/** Exponential backoff for the Nth failed attempt (1-based), capped. */
export function retryDelayMs(attempt: number): number {
  const d = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(d, RETRY_CAP_MS);
}

// ---- business types (onboarding presets) -----------------------------------

interface BusinessTypeRoutine {
  name: string;
  intervalHours: number;
  role: string | null;
  instruction: string;
}

export const BUSINESS_TYPE_IDS = ["software", "game-studio", "vc", "ecommerce", "custom"] as const;
export type BusinessTypeId = (typeof BUSINESS_TYPE_IDS)[number];

export interface BusinessType {
  id: BusinessTypeId;
  label: string;
  emoji: string;
  pitchPlaceholder: string;
  hireHint: string;
  routine: BusinessTypeRoutine | null;
}

export const BUSINESS_TYPES: readonly BusinessType[] = [
  {
    id: "software",
    label: "Software company",
    emoji: "💻",
    pitchPlaceholder: "A delightful to-do app that makes planning feel effortless.",
    hireHint: "Lean product team: engineers, a designer, and someone on growth/marketing.",
    routine: null,
  },
  {
    id: "game-studio",
    label: "Game studio",
    emoji: "🎮",
    pitchPlaceholder: "A cozy pixel-art farming roguelike playable in the browser.",
    hireHint: "A game needs gameplay engineering, pixel art, sound, and game design.",
    routine: {
      name: "Playtest session",
      intervalHours: 24,
      role: "design",
      instruction:
        "Play the current build end to end. Log what's broken or unfun, then fix the worst issue or delegate it to the right teammate.",
    },
  },
  {
    id: "vc",
    label: "Venture capital firm",
    emoji: "💼",
    pitchPlaceholder:
      "A micro-VC that sources and writes investment memos on early-stage AI startups.",
    hireHint: "An investment firm needs sourcing, analysis/research, and investor-facing writing.",
    routine: {
      name: "Deal pipeline review",
      intervalHours: 24,
      role: "analy",
      instruction:
        "Review the pipeline docs in the workspace, source 3 new candidate companies, and write or refresh one investment memo.",
    },
  },
  {
    id: "ecommerce",
    label: "E-commerce business",
    emoji: "🛒",
    pitchPlaceholder: "An online store selling artist-designed enamel pins.",
    hireHint: "A shop needs product/merchandising, storefront engineering, ops, and marketing.",
    routine: {
      name: "Store audit",
      intervalHours: 24,
      role: "market",
      instruction:
        "Walk the storefront as a customer: product pages, copy, pricing, checkout. Improve the weakest page and draft one promotion.",
    },
  },
  {
    id: "custom",
    label: "Something else…",
    emoji: "✨",
    pitchPlaceholder: "A daily AI-curated newsletter for indie hackers.",
    hireHint: "",
    routine: null,
  },
];

export function businessTypeById(id: BusinessTypeId): BusinessType {
  const found = BUSINESS_TYPES.find((b) => b.id === id);
  if (!found) throw new Error(`unknown business type ${id}`);
  return found;
}

// ---- budget (real token spend) ----------------------------------------------

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
  id: string; // slug
  name: string;
  mission: string;
  businessType: BusinessTypeId;
  workspaceDir: string;
  founderName: string;
  founderSpriteSeed: string;
  autopilot: boolean; // when true, idle employees self-direct work (idle-game loop)
  maxAgents: number; // seat cap — the team lead hires/releases freely below it
  ships: number; // units of work the team has shipped
  revenueUsd: number | null; // REAL revenue (Stripe); null until a source is connected
  users: number | null; // REAL users (analytics); null until a source is connected
  budget: Budget; // founder-set cap on real AI spend
  spentUsd: number; // lifetime real token spend (USD)
  createdAt: number;
}

export interface Employee {
  id: string; // slug (folder name under agents/)
  companyId: string;
  name: string;
  role: string;
  title: string;
  persona: string; // system-prompt flavor for the agent
  runner: AgentRunner; // which CLI executes this employee
  sessionId: string | null;
  spriteSeed: string; // deterministic sprite + portrait
  deskIndex: number; // which desk slot in the office
  teamId: string | null; // which team this employee belongs to (TinyAGI-style)
  status: EmployeeStatus;
  createdAt: number;
}

/**
 * A named group of employees with a designated leader (TinyAGI-style team).
 * The leader receives direction and fans work out to / chains it through members;
 * everyone shares a persistent chat room they read and post to during runs.
 */
export interface Team {
  id: string; // slug (folder name under teams/)
  companyId: string;
  name: string;
  purpose: string; // what this team owns
  leaderId: string | null; // employee id of the team lead
  memberIds: string[]; // employee ids on this team (includes the leader)
  createdAt: number;
}

/** One message in a team's chat room. */
export interface TeamMessage {
  id?: number;
  teamId: string;
  fromEmployeeId: string | null; // null = system/founder
  text: string;
  createdAt: number;
}

/**
 * Where a task is, with only what that place needs: a queued task knows its
 * backoff, a running one its run, a blocked one the ask, a finished one what
 * it left behind. Nothing else can be read in a state it does not belong to.
 */
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
  id: string; // slug (folder name under tasks/)
  companyId: string;
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

/** A recurring directive: fires as a real task on a cadence (Paperclip-style heartbeat). */
export interface Routine {
  id: string; // slug (folder name under routines/)
  companyId: string;
  name: string;
  instruction: string;
  intervalHours: number;
  role: string | null; // preferred assignee role (substring match), else anyone idle
  lastRunAt: number | null;
}
