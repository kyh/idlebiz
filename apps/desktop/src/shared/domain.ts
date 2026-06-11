// Domain shapes shared across main (control plane) and renderer (game UI).
// Pure types — safe to import anywhere.
//
// Identity: ids ARE agentcompanies/v1 slugs (URL-safe, human-readable). A
// company's id is its folder name under ~/.idlebiz; an employee's id is its
// folder name under agents/; a task's id is its folder name under tasks/.

// The one place the default agent model lives.
export const DEFAULT_PROVIDER = "openai-codex";
export const DEFAULT_MODEL_ID = "gpt-5.5";
export const DEFAULT_AGENT_MODEL = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`;

/** What hiring one employee costs after the founding team. */
export const HIRE_COST = 150;

export type TaskStatus =
  | "todo"
  | "queued"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";
export type TaskPriority = "low" | "medium" | "high";
export type EmployeeStatus = "idle" | "working";

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
  cash: number; // in-game dollars (light economy; real metrics providers later)
  ships: number; // units of work the team has shipped
  users: number; // simulated adoption — grows as the product ships
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
  model: string; // "provider/model"
  thinking: string | null;
  sessionId: string | null;
  spriteSeed: string; // deterministic sprite + portrait
  deskIndex: number; // which desk slot in the office
  status: EmployeeStatus;
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
  blockedQuestion: string | null;
  artifacts: string[]; // file paths the agent reported
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

export type ActivityKind =
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
