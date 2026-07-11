// Domain shapes shared across main (control plane) and renderer (game UI).
// Pure types — safe to import anywhere.
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

/** Hard ceiling on team size — the LLM staffs freely underneath it. */
export const DEFAULT_MAX_AGENTS = 12;

// ---- blocked asks ------------------------------------------------------------
// Why a task is waiting on the founder. Structured end-to-end: a free-text
// question gets an answer box; an integration request renders a [Connect]
// button and the task auto-resumes once the founder connects.

export type IntegrationKind = "vercel" | "stripe";

export const INTEGRATION_LABELS: Record<IntegrationKind, string> = {
  vercel: "Vercel",
  stripe: "Stripe",
};

export type BlockedAsk =
  | { type: "question"; question: string }
  | { type: "integration"; integration: IntegrationKind; reason: string };

// TASK.md keeps a single human-editable scalar; the marker syntax exists ONLY
// at this persistence boundary — everything in memory is the typed union.
export function serializeBlockedAsk(a: BlockedAsk): string {
  return a.type === "question" ? a.question : `[connect:${a.integration}] ${a.reason}`;
}

export function parseBlockedAsk(s: string): BlockedAsk {
  const m = /^\[connect:(vercel|stripe)\]\s*([\s\S]*)$/.exec(s);
  if (!m) return { type: "question", question: s };
  return {
    type: "integration",
    integration: m[1] === "vercel" ? "vercel" : "stripe",
    reason: (m[2] ?? "").trim(),
  };
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

export type TaskStatus =
  | "todo"
  | "queued"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "dead" // dead-letter: failed maxAttempts times, no longer auto-retried
  | "cancelled";
export type TaskPriority = "low" | "medium" | "high";
type EmployeeStatus = "idle" | "working";

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

export interface BusinessType {
  id: "software" | "game-studio" | "vc" | "ecommerce" | "custom";
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

export type BusinessTypeId = BusinessType["id"];

export function businessTypeById(id: BusinessTypeId): BusinessType {
  const found = BUSINESS_TYPES.find((b) => b.id === id);
  if (!found) throw new Error(`unknown business type ${id}`);
  return found;
}

// ---- budget (real token spend) ----------------------------------------------

/** Founder's AI spending budget. Infinite IS the off state — no third mode. */
export type Budget = { mode: "infinite" } | { mode: "capped"; capUsd: number };

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
  onboarded: boolean;
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
  model: string | null; // model override; null = the CLI's own default
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

export interface Task {
  id: string; // slug (folder name under tasks/)
  companyId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  runId: string | null;
  summary: string | null;
  blocked: BlockedAsk | null; // why this task awaits the founder (status "blocked")
  artifacts: string[]; // file paths the agent reported
  attempts: number; // failed runs so far (drives retry/dead-letter)
  nextAttemptAt: number | null; // earliest time a backoff retry may start
  lastError: string | null; // most recent failure message
  createdAt: number;
  startedAt: number | null;
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

type ActivityKind =
  | "log"
  | "tool_call"
  | "status"
  | "lifecycle"
  | "thinking"
  | "message"
  | "chat"
  | "ship";

export interface ActivityEvent {
  id?: number;
  runId?: string | null;
  taskId?: string | null;
  employeeId?: string | null;
  kind: ActivityKind;
  message?: string | null;
  payload?: unknown;
  createdAt: number;
}
