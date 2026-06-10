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

export interface Company {
  id: string; // slug
  name: string;
  mission: string;
  workspaceDir: string;
  founderName: string;
  founderSpriteSeed: string;
  autopilot: boolean; // when true, idle employees self-direct work (idle-game loop)
  cash: number; // in-game dollars (light economy; real metrics providers later)
  ships: number; // units of work the team has shipped
  users: number; // simulated adoption — grows as the product ships
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
