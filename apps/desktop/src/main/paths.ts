import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// Everything IdleBiz owns lives under ~/.idlebiz. Each company is a
// human-readable agentcompanies/v1 package:
//   ~/.idlebiz/<company-slug>/
//     COMPANY.md            company metadata + mission (canonical save file)
//     agents/<slug>/        one folder per employee
//       AGENTS.md           the agent's canonical definition — pi reads this file
//       memory/             the agent's own scratch memory
//       sessions/           pi session continuity
//     tasks/<slug>/TASK.md  work items
//     workspace/            shared cwd where agents do real work
//     activity.jsonl        append-only event log (non-canonical)
//
// OpenAI credentials live at ~/.idlebiz/auth.json (written by the in-game
// OAuth flow during onboarding).
export const ROOT_DIR = join(homedir(), ".idlebiz");
export const AUTH_PATH = join(ROOT_DIR, "auth.json");

/** Global pi fallback dir (set once via env before any agent starts). */
export const PI_AGENT_DIR = join(ROOT_DIR, "pi");

export const companyDir = (companySlug: string): string => join(ROOT_DIR, companySlug);
export const companyFile = (companySlug: string): string => join(companyDir(companySlug), "COMPANY.md");
/** Shared workspace where all of a company's employees do real work together. */
export const companyWorkspace = (companySlug: string): string => join(companyDir(companySlug), "workspace");
export const activityFile = (companySlug: string): string => join(companyDir(companySlug), "activity.jsonl");

export const agentsDir = (companySlug: string): string => join(companyDir(companySlug), "agents");
/** Per-employee package dir; doubles as the pi agentDir (AGENTS.md lives here). */
export const employeeAgentDir = (companySlug: string, employeeSlug: string): string =>
  join(agentsDir(companySlug), employeeSlug);
export const employeeFile = (companySlug: string, employeeSlug: string): string =>
  join(employeeAgentDir(companySlug, employeeSlug), "AGENTS.md");
export const employeeMemoryDir = (companySlug: string, employeeSlug: string): string =>
  join(employeeAgentDir(companySlug, employeeSlug), "memory");
export const employeeSessionDir = (companySlug: string, employeeSlug: string): string =>
  join(employeeAgentDir(companySlug, employeeSlug), "sessions");

export const tasksDir = (companySlug: string): string => join(companyDir(companySlug), "tasks");
export const taskFile = (companySlug: string, taskSlug: string): string => join(tasksDir(companySlug), taskSlug, "TASK.md");

export const routinesDir = (companySlug: string): string => join(companyDir(companySlug), "routines");
export const routineFile = (companySlug: string, routineSlug: string): string =>
  join(routinesDir(companySlug), routineSlug, "ROUTINE.md");

export function ensureAppDirs(): void {
  mkdirSync(ROOT_DIR, { recursive: true });
  mkdirSync(PI_AGENT_DIR, { recursive: true });
}
