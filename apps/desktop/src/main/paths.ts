import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// Everything IdleBiz owns lives under ~/.idlebiz. Each company is a
// human-readable agentcompanies/v1 package:
//   ~/.idlebiz/<company-slug>/
//     COMPANY.md            company metadata + mission (canonical save file)
//     agents/<slug>/        one folder per employee
//       AGENTS.md           the agent's canonical definition, injected into every run
//       memory/             the agent's own scratch memory
//       sessions/           the agent's own session continuity
//     tasks/<slug>/TASK.md  work items
//     workspace/            shared cwd where agents do real work
//     chat.jsonl            the company room (non-canonical, append-only)
//     activity.jsonl        append-only event log (non-canonical)
//
// Agents run on the player's own coding CLIs (claude / codex), which manage
// their own credentials — IdleBiz stores no model-provider auth.
export const ROOT_DIR = join(homedir(), ".idlebiz");
/** The player's saved office layout (built in #/ui). Overrides the bundled default. */
export const OFFICE_DESIGN_PATH = join(ROOT_DIR, "office-design.json");

export const companyDir = (companySlug: string): string => join(ROOT_DIR, companySlug);
export const companyFile = (companySlug: string): string =>
  join(companyDir(companySlug), "COMPANY.md");
/** Shared workspace where all of a company's employees do real work together. */
export const companyWorkspace = (companySlug: string): string =>
  join(companyDir(companySlug), "workspace");
export const activityFile = (companySlug: string): string =>
  join(companyDir(companySlug), "activity.jsonl");

export const agentsDir = (companySlug: string): string => join(companyDir(companySlug), "agents");
/** Released employees are archived here (package preserved, never deleted). */
export const alumniDir = (companySlug: string): string => join(companyDir(companySlug), "alumni");
/** Per-employee package dir (AGENTS.md lives here); granted to the agent as a writable root. */
export const employeeAgentDir = (companySlug: string, employeeSlug: string): string =>
  join(agentsDir(companySlug), employeeSlug);
export const employeeFile = (companySlug: string, employeeSlug: string): string =>
  join(employeeAgentDir(companySlug, employeeSlug), "AGENTS.md");
export const employeeMemoryDir = (companySlug: string, employeeSlug: string): string =>
  join(employeeAgentDir(companySlug, employeeSlug), "memory");
export const employeeSessionDir = (companySlug: string, employeeSlug: string): string =>
  join(employeeAgentDir(companySlug, employeeSlug), "sessions");

export const tasksDir = (companySlug: string): string => join(companyDir(companySlug), "tasks");
export const taskFile = (companySlug: string, taskSlug: string): string =>
  join(tasksDir(companySlug), taskSlug, "TASK.md");

/** Commands the founder has signed off but the agent has not run yet. */
export const approvalsFile = (companySlug: string): string =>
  join(companyDir(companySlug), "approvals.json");

export const routinesDir = (companySlug: string): string =>
  join(companyDir(companySlug), "routines");
export const routineFile = (companySlug: string, routineSlug: string): string =>
  join(routinesDir(companySlug), routineSlug, "ROUTINE.md");

/** Append-only company chat room (the room agents read + post to during runs). */
export const chatFile = (companySlug: string): string =>
  join(companyDir(companySlug), "chat.jsonl");
/** Where saves from before the room was the company's kept it: one folder per team. */
export const legacyTeamsDir = (companySlug: string): string =>
  join(companyDir(companySlug), "teams");

export function ensureAppDirs(): void {
  mkdirSync(ROOT_DIR, { recursive: true });
}
