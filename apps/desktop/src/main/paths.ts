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
export const taskFile = (companySlug: string, taskSlug: string): string =>
  join(tasksDir(companySlug), taskSlug, "TASK.md");

export const routinesDir = (companySlug: string): string =>
  join(companyDir(companySlug), "routines");
export const routineFile = (companySlug: string, routineSlug: string): string =>
  join(routinesDir(companySlug), routineSlug, "ROUTINE.md");

export const teamsDir = (companySlug: string): string => join(companyDir(companySlug), "teams");
export const teamFile = (companySlug: string, teamSlug: string): string =>
  join(teamsDir(companySlug), teamSlug, "TEAM.md");
/** Append-only per-team chat room (the room agents read + post to during runs). */
export const teamChatFile = (companySlug: string, teamSlug: string): string =>
  join(teamsDir(companySlug), teamSlug, "chat.jsonl");

export function ensureAppDirs(): void {
  mkdirSync(ROOT_DIR, { recursive: true });
}
