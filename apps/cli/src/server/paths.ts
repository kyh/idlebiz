import { homedir } from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

// Default save layout; IDLEBIZ_ROOT_DIR overrides the root. A root holds one company or none,
// a human-readable agentcompanies/v1 package:
//   ~/.idlebiz/company/
//     COMPANY.md            company metadata + mission (canonical save file)
//     agents/<slug>/        one folder per employee
//       AGENTS.md           the agent's canonical definition, injected into every run
//       memory/             the agent's own scratch memory
//       run-state.json      what a run leaves for the next: session to resume and what it was told, the real numbers as it ended, the last ship
//     tasks/<slug>/TASK.md  open work
//     shipped/<slug>/TASK.md  work the team finished (the shipping log), asks the founder answered, order cards they settled, work the steering loop dropped
//     products/<slug>/PRODUCT.md  a product: what it is, where it deploys
//     products/<slug>/workspace/  its code
//     retired/<slug>/       a product the lead killed: its package and its code, moved here whole
//     bets/<slug>/BET.md    a bet: a hypothesis about one real number, a spend cap, a verdict
//     listings/<id>.json    a print-on-demand item on sale for a product: the Printful variants and design, its payment link and whether it still sells
//     links/<id>.json       a create_payment_link link, by Stripe's id: what it sells for which product, and whether it still sells
//     orders/<id>.json      a paid checkout on one of the company's payment links (a listing's or create_payment_link's), and what became of it
//     shared/               what teammates share across products; the cwd of work no product owns
//     chat.jsonl            the company room (non-canonical, append-only)
//     activity.jsonl        append-only event log (non-canonical): an audit trail, written and never read back
//     state/                running state main keeps for itself; deleting it loses nothing canonical
//       since-last-look.json  the founder's digest, folded from each event as it happens
//       recent-ships.json     the latest ship summaries, for the next brief
//       policy.json           how the allocator weighs bets, retuned by replaying closed ones
//       orders-cursor.json    where each Stripe key's next read of checkouts starts
//       runner-rest.json      until when each runner rests on a usage limit, an overload or a refusal of access, so a restart does not spawn each parked task to be refused
//
// Agents run on the player's own coding CLIs (claude / codex), which manage
// their own credentials — IdleBiz stores no model-provider auth.
const DEFAULT_ROOT_DIR = path.join(homedir(), ".idlebiz");
export const ROOT_DIR = path.resolve(process.env.IDLEBIZ_ROOT_DIR ?? DEFAULT_ROOT_DIR);
/** Whether this launch runs on the founder's own save rather than an isolated root. */
export const ON_REAL_SAVE = ROOT_DIR === DEFAULT_ROOT_DIR;

/** The save: a folder of its own, so founding publishes the whole company with one rename. */
export const COMPANY_DIR = path.join(ROOT_DIR, "company");
/** The cache every run may write, beside the save. */
export const TOOL_CACHE_DIR = path.join(ROOT_DIR, "cache");
/** Where main writes the `idlebiz` command each run finds first on its PATH (agent-launcher.ts), which no run writes. */
export const RUN_BIN_DIR = path.join(ROOT_DIR, "bin");
export const COMPANY_FILE = path.join(COMPANY_DIR, "COMPANY.md");
/** What teammates share across products, and the working directory of work no product owns. */
export const SHARED_DIR = path.join(COMPANY_DIR, "shared");
/** Running state main keeps for itself: small JSON written as things happen, safe to delete.
 *  What the founder configured (approvals.json) is not state and stays beside COMPANY.md. */
const STATE_DIR = path.join(COMPANY_DIR, "state");
/** The latest ship summaries, for the brief's "recently shipped" lines. */
export const RECENT_SHIPS_FILE = path.join(STATE_DIR, "recent-ships.json");
/** The founder's digest-in-progress: what has happened since they last looked. */
export const SINCE_LAST_LOOK_FILE = path.join(STATE_DIR, "since-last-look.json");
/** Where the next read of Stripe's checkouts starts; deleted, it reads again from the company's founding and finds each order already kept. */
export const ORDERS_CURSOR_FILE = path.join(STATE_DIR, "orders-cursor.json");
/** Until when each runner rests on a usage limit, an overload or a refusal of access; deleted, each task waiting on one spawns once more to be refused. */
export const RUNNER_REST_FILE = path.join(STATE_DIR, "runner-rest.json");
export const ACTIVITY_FILE = path.join(COMPANY_DIR, "activity.jsonl");

export const AGENTS_DIR = path.join(COMPANY_DIR, "agents");
/** Released employees are archived here (package preserved, never deleted). */
export const ALUMNI_DIR = path.join(COMPANY_DIR, "alumni");
/** Per-employee package dir (AGENTS.md lives here). */
export const employeeAgentDir = (employeeSlug: string): string =>
  path.join(AGENTS_DIR, employeeSlug);
export const employeeFile = (employeeSlug: string): string =>
  path.join(employeeAgentDir(employeeSlug), "AGENTS.md");
/** What a run leaves behind for the next one: the session to resume, where the numbers stood.
 *  Beside AGENTS.md, not in it, so the instructions only change when the instructions do. */
export const employeeRunStateFile = (employeeSlug: string): string =>
  path.join(employeeAgentDir(employeeSlug), "run-state.json");
/** The agent's own notes; granted to it as a writable root. */
export const employeeMemoryDir = (employeeSlug: string): string =>
  path.join(employeeAgentDir(employeeSlug), "memory");

export const TASKS_DIR = path.join(COMPANY_DIR, "tasks");
export const taskFile = (taskSlug: string): string => path.join(TASKS_DIR, taskSlug, "TASK.md");
/**
 * Closed tasks move here: ships, answered asks and dropped work. The open queue is
 * what boot reads and the scheduler scans; history grows without bound and is read
 * when a panel asks.
 */
export const SHIPPED_DIR = path.join(COMPANY_DIR, "shipped");
export const shippedTaskFile = (taskSlug: string): string =>
  path.join(SHIPPED_DIR, taskSlug, "TASK.md");

export const PRODUCTS_DIR = path.join(COMPANY_DIR, "products");
export const productFile = (productSlug: string): string =>
  path.join(PRODUCTS_DIR, productSlug, "PRODUCT.md");
/** A product's code, inside its package so the two retire in one move. */
export const productWorkspace = (productSlug: string): string =>
  path.join(PRODUCTS_DIR, productSlug, "workspace");
// Listings, links and orders sit outside every product's package: a retired product's payment
// links are switched off from them, and each order they took must still ship and be tracked.
// Outside every workspace too, so a run can read them, buyers' addresses included, but never
// write one.
export const LISTINGS_DIR = path.join(COMPANY_DIR, "listings");
export const listingFile = (listingId: string): string =>
  path.join(LISTINGS_DIR, `${listingId}.json`);
export const LINKS_DIR = path.join(COMPANY_DIR, "links");
export const linkFile = (linkId: string): string => path.join(LINKS_DIR, `${linkId}.json`);
export const ORDERS_DIR = path.join(COMPANY_DIR, "orders");
export const orderFile = (orderId: string): string => path.join(ORDERS_DIR, `${orderId}.json`);

/** Killed products are archived here (package and workspace preserved, never deleted). */
export const RETIRED_DIR = path.join(COMPANY_DIR, "retired");

export const BETS_DIR = path.join(COMPANY_DIR, "bets");
export const betFile = (betSlug: string): string => path.join(BETS_DIR, betSlug, "BET.md");
/** The allocator's tuned parameters; deleting it falls back to the defaults. */
export const POLICY_FILE = path.join(STATE_DIR, "policy.json");

/** Commands the founder has signed off but the agent has not run yet. */
export const APPROVALS_FILE = path.join(COMPANY_DIR, "approvals.json");

export const ROUTINES_DIR = path.join(COMPANY_DIR, "routines");
export const routineFile = (routineSlug: string): string =>
  path.join(ROUTINES_DIR, routineSlug, "ROUTINE.md");

/** Append-only company chat room (the room agents read + post to during runs). */
export const CHAT_FILE = path.join(COMPANY_DIR, "chat.jsonl");

export const ensureAppDirs = (): void => {
  mkdirSync(ROOT_DIR, { recursive: true });
};
