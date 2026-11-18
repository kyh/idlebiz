import { homedir } from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

const DEFAULT_ROOT_DIR = path.join(homedir(), ".idlebiz");

/** The save a launch opens: IDLEBIZ_ROOT_DIR's, or the founder's own. */
export const launchRoot = (env: NodeJS.ProcessEnv) =>
  path.resolve(env.IDLEBIZ_ROOT_DIR ?? DEFAULT_ROOT_DIR);

let openedRoot: string | null = null;

/** Points every path below at the save at `root`: serve's first step, or a test's own save. */
export const openSave = (root: string) => {
  openedRoot = path.resolve(root);
};

// WARNING: read the root at every call, never at import, or a test can land in the founder's save.
export const rootDir = () => {
  if (openedRoot === null) {
    throw new Error(
      "no save is open: serve opens its launch's, a test its own (test-support/save.ts)",
    );
  }

  return openedRoot;
};

/** The save: a folder of its own, so founding publishes the whole company with one rename. */
export const companyDir = () => path.join(rootDir(), "company");

/** The cache every run may write, beside the save. */
export const toolCacheDir = () => path.join(rootDir(), "cache");

/** Where main writes the `idlebiz` command each run finds first on its PATH (agent-launcher.ts), which no run writes. */
export const runBinDir = () => path.join(rootDir(), "bin");
export const companyFile = () => path.join(companyDir(), "COMPANY.md");
export const sharedDir = () => path.join(companyDir(), "shared");
const stateDir = () => path.join(companyDir(), "state");
export const recentShipsFile = () => path.join(stateDir(), "recent-ships.json");
export const sinceLastLookFile = () => path.join(stateDir(), "since-last-look.json");

/** When the lead's latest proposal to end done was briefed and ended, so allocating reads no history; deleted, the lead is asked once more. */
export const lastProposalFile = () => path.join(stateDir(), "last-proposal.json");

/** Where the next read of Stripe's checkouts starts; deleted, it reads again from the company's founding and finds each order already kept. */
export const ordersCursorFile = () => path.join(stateDir(), "orders-cursor.json");

/** Until when each runner rests on a usage limit, an overload or a refusal of access; deleted, each task waiting on one spawns once more to be refused. */
export const runnerRestFile = () => path.join(stateDir(), "runner-rest.json");
export const activityFile = () => path.join(companyDir(), "activity.jsonl");

export const agentsDir = () => path.join(companyDir(), "agents");
export const alumniDir = () => path.join(companyDir(), "alumni");

export const employeeAgentDir = (employeeSlug: string) => path.join(agentsDir(), employeeSlug);

export const employeeFile = (employeeSlug: string) =>
  path.join(employeeAgentDir(employeeSlug), "AGENTS.md");

/** Beside AGENTS.md, not in it, so the instructions only change when the instructions do. */
export const employeeRunStateFile = (employeeSlug: string) =>
  path.join(employeeAgentDir(employeeSlug), "run-state.json");

/** The agent's own notes; granted to it as a writable root. */
export const employeeMemoryDir = (employeeSlug: string) =>
  path.join(employeeAgentDir(employeeSlug), "memory");

export const tasksDir = () => path.join(companyDir(), "tasks");
export const taskFile = (taskSlug: string) => path.join(tasksDir(), taskSlug, "TASK.md");

/**
 * Closed tasks move here: ships, answered asks, settled order cards and dropped work. The
 * open queue is what boot reads and the scheduler scans; history grows without bound and is
 * read when a panel asks.
 */
export const shippedDir = () => path.join(companyDir(), "shipped");

export const shippedTaskFile = (taskSlug: string) => path.join(shippedDir(), taskSlug, "TASK.md");

export const productsDir = () => path.join(companyDir(), "products");

export const productFile = (productSlug: string) =>
  path.join(productsDir(), productSlug, "PRODUCT.md");

/** A product's code, inside its package so the two retire in one move. */
export const productWorkspace = (productSlug: string) =>
  path.join(productsDir(), productSlug, "workspace");

export const listingsDir = () => path.join(companyDir(), "listings");

export const listingFile = (listingId: string) => path.join(listingsDir(), `${listingId}.json`);

export const linksDir = () => path.join(companyDir(), "links");
export const linkFile = (linkId: string) => path.join(linksDir(), `${linkId}.json`);
export const ordersDir = () => path.join(companyDir(), "orders");
export const orderFile = (orderId: string) => path.join(ordersDir(), `${orderId}.json`);

export const retiredDir = () => path.join(companyDir(), "retired");

export const betsDir = () => path.join(companyDir(), "bets");
export const betFile = (betSlug: string) => path.join(betsDir(), betSlug, "BET.md");
export const policyFile = () => path.join(stateDir(), "policy.json");

export const approvalsFile = () => path.join(companyDir(), "approvals.json");

export const routinesDir = () => path.join(companyDir(), "routines");

export const routineFile = (routineSlug: string) =>
  path.join(routinesDir(), routineSlug, "ROUTINE.md");

export const chatFile = () => path.join(companyDir(), "chat.jsonl");

export const ensureAppDirs = () => {
  mkdirSync(rootDir(), { recursive: true });
};
