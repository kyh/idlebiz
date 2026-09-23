import { homedir } from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

// Default save layout; IDLEBIZ_ROOT_DIR overrides the root.
// Each company is a human-readable agentcompanies/v1 package:
//   ~/.idlebiz/<company-slug>/
//     COMPANY.md            company metadata + mission (canonical save file)
//     agents/<slug>/        one folder per employee
//       AGENTS.md           the agent's canonical definition, injected into every run
//       memory/             the agent's own scratch memory
//       sessions/           the agent's own session continuity
//       run-state.json      what a run leaves for the next: session to resume, the real numbers as it ended
//     tasks/<slug>/TASK.md  open work
//     shipped/<slug>/TASK.md  work the team finished (the shipping log), and asks the founder answered
//     products/<slug>/PRODUCT.md  a product: what it is, where it deploys
//     products/<slug>/workspace/  its code (the first product uses workspace/)
//     retired/<slug>/       a product the lead killed: its package, moved here whole
//     bets/<slug>/BET.md    a bet: a hypothesis about one real number, a spend cap, a verdict
//     workspace/            shared cwd where agents do real work
//     chat.jsonl            the company room (non-canonical, append-only)
//     activity.jsonl        append-only event log (non-canonical): an audit trail, written and never read back
//     state/                running state main keeps for itself; deleting it loses nothing canonical
//       since-last-look.json  the founder's digest, folded from each event as it happens
//       recent-ships.json     the latest ship summaries, for the next brief
//       policy.json           how the allocator weighs bets, retuned by replaying closed ones
//
// Agents run on the player's own coding CLIs (claude / codex), which manage
// their own credentials — IdleBiz stores no model-provider auth.
export const ROOT_DIR = path.resolve(
  process.env["IDLEBIZ_ROOT_DIR"] ?? path.join(homedir(), ".idlebiz"),
);
/** The player's saved office layout (built in #/ui). Overrides the bundled default. */
export const OFFICE_DESIGN_PATH = path.join(ROOT_DIR, "office-design.json");

export const companyDir = (companySlug: string): string => path.join(ROOT_DIR, companySlug);
export const companyFile = (companySlug: string): string =>
  path.join(companyDir(companySlug), "COMPANY.md");
/** Shared workspace where all of a company's employees do real work together. */
export const companyWorkspace = (companySlug: string): string =>
  path.join(companyDir(companySlug), "workspace");
/** Running state main keeps for itself: small JSON written as things happen, safe to delete.
 *  What the founder configured (metrics.json, approvals.json) is not state and stays beside COMPANY.md. */
const stateDir = (companySlug: string): string => path.join(companyDir(companySlug), "state");
/** The latest ship summaries, for the brief's "recently shipped" lines. */
export const recentShipsFile = (companySlug: string): string =>
  path.join(stateDir(companySlug), "recent-ships.json");
/** The founder's digest-in-progress: what has happened since they last looked. */
export const sinceLastLookFile = (companySlug: string): string =>
  path.join(stateDir(companySlug), "since-last-look.json");
export const activityFile = (companySlug: string): string =>
  path.join(companyDir(companySlug), "activity.jsonl");

export const agentsDir = (companySlug: string): string =>
  path.join(companyDir(companySlug), "agents");
/** Released employees are archived here (package preserved, never deleted). */
export const alumniDir = (companySlug: string): string =>
  path.join(companyDir(companySlug), "alumni");
/** Per-employee package dir (AGENTS.md lives here); granted to the agent as a writable root. */
export const employeeAgentDir = (companySlug: string, employeeSlug: string): string =>
  path.join(agentsDir(companySlug), employeeSlug);
export const employeeFile = (companySlug: string, employeeSlug: string): string =>
  path.join(employeeAgentDir(companySlug, employeeSlug), "AGENTS.md");
/** What a run leaves behind for the next one: the session to resume, where the numbers stood.
 *  Beside AGENTS.md, not in it, so the instructions only change when the instructions do. */
export const employeeRunStateFile = (companySlug: string, employeeSlug: string): string =>
  path.join(employeeAgentDir(companySlug, employeeSlug), "run-state.json");
export const employeeMemoryDir = (companySlug: string, employeeSlug: string): string =>
  path.join(employeeAgentDir(companySlug, employeeSlug), "memory");
export const employeeSessionDir = (companySlug: string, employeeSlug: string): string =>
  path.join(employeeAgentDir(companySlug, employeeSlug), "sessions");

export const tasksDir = (companySlug: string): string =>
  path.join(companyDir(companySlug), "tasks");
export const taskFile = (companySlug: string, taskSlug: string): string =>
  path.join(tasksDir(companySlug), taskSlug, "TASK.md");
/**
 * Done tasks move here. The open queue is what boot reads and the scheduler
 * scans; the shipping log grows without bound and is read when a panel asks.
 */
export const shippedDir = (companySlug: string): string =>
  path.join(companyDir(companySlug), "shipped");
export const shippedTaskFile = (companySlug: string, taskSlug: string): string =>
  path.join(shippedDir(companySlug), taskSlug, "TASK.md");

export const productsDir = (companySlug: string): string =>
  path.join(companyDir(companySlug), "products");
export const productFile = (companySlug: string, productSlug: string): string =>
  path.join(productsDir(companySlug), productSlug, "PRODUCT.md");
/** A later product's own workspace; the first product lives in the company workspace. */
export const productWorkspace = (companySlug: string, productSlug: string): string =>
  path.join(productsDir(companySlug), productSlug, "workspace");

/** Killed products are archived here (package and workspace preserved, never deleted). */
export const retiredDir = (companySlug: string): string =>
  path.join(companyDir(companySlug), "retired");

export const betsDir = (companySlug: string): string => path.join(companyDir(companySlug), "bets");
export const betFile = (companySlug: string, betSlug: string): string =>
  path.join(betsDir(companySlug), betSlug, "BET.md");
/** The allocator's tuned parameters; deleting it falls back to the defaults. */
export const policyFile = (companySlug: string): string =>
  path.join(stateDir(companySlug), "policy.json");

/** Commands the founder has signed off but the agent has not run yet. */
export const approvalsFile = (companySlug: string): string =>
  path.join(companyDir(companySlug), "approvals.json");

export const routinesDir = (companySlug: string): string =>
  path.join(companyDir(companySlug), "routines");
export const routineFile = (companySlug: string, routineSlug: string): string =>
  path.join(routinesDir(companySlug), routineSlug, "ROUTINE.md");

/** Append-only company chat room (the room agents read + post to during runs). */
export const chatFile = (companySlug: string): string =>
  path.join(companyDir(companySlug), "chat.jsonl");
/** Where saves from before the room was the company's kept it: one folder per team. */
export const legacyTeamsDir = (companySlug: string): string =>
  path.join(companyDir(companySlug), "teams");

export const ensureAppDirs = (): void => {
  mkdirSync(ROOT_DIR, { recursive: true });
};
