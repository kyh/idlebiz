import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import type { BlockedAsk } from "@repo/domain/domain";
import type { JsonValue } from "@repo/domain/json";
import type { RunnerId } from "@repo/domain/runners";
import type { DeployRequest, DeployResult } from "../deploy";
import type { ChargeLink } from "../link-record";
import type { ToolName } from "../tool-specs";
import type { RunContext } from "./define";

// What the tools' tests share. Importing this points the save at a root of the importing test
// file's own before anything reads server/paths, and empties it before each test.
export const root = mkdtempSync(path.join(tmpdir(), "idlebiz-tools-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const store = await import("../store/store");
const { askBox } = await import("../agents/ask-box");
const { callTool: outcomeOf } = await import("./index");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

/** What a call answers the agent, however it ended. */
export const callTool = async (
  ctx: RunContext,
  name: ToolName,
  raw: JsonValue,
): Promise<string> => {
  const { text } = await outcomeOf(ctx, name, raw);
  return text;
};

export const hire = (name: string, title: string, runner: RunnerId = "claude") =>
  ({
    name,
    persona: "ships",
    role: "engineer",
    runner,
    spriteSeed: name,
    title,
  }) as const;

/** A run by `employeeId` in a fresh company led by Mae, of two unless `more` join them. */
export const runAs = (employeeId: string, more: readonly ReturnType<typeof hire>[] = []) => {
  const company = store.foundCompany({
    budget: { mode: "infinite" },
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [hire("Mae", "General Manager"), hire("Priya", "Engineer"), ...more],
    mission: "ship",
    name: "Acme",
  });
  const employee = store.getEmployee(employeeId);
  if (!employee) {
    throw new Error(`no ${employeeId}`);
  }
  const asked: BlockedAsk[] = [];
  const assigned: string[] = [];
  const ctx: RunContext = {
    asks: askBox((ask) => asked.push(ask)),
    // the scheduler queues what it is handed, and queued work is in flight
    assign: (taskId, assigneeId) => {
      assigned.push(taskId);
      store.claimTask(taskId, assigneeId);
    },
    checkVercelToken: () =>
      Promise.reject(new Error("asked Vercel about its token without a test asking for it")),
    checkoutAccess: () =>
      Promise.reject(new Error("asked Stripe about checkouts without a test asking for it")),
    company,
    createPaymentLink: () => Promise.reject(new Error("charged without a test asking for it")),
    deploy: () => Promise.reject(new Error("deployed without a test asking for it")),
    driver: { pickRunner: () => "claude", restingRunner: () => null, signedIn: () => true },
    employee,
    linkAccess: () =>
      Promise.reject(new Error("asked Stripe about payment links without a test asking for it")),
    printListing: {
      catalog: () =>
        Promise.reject(new Error("read Printful's catalog without a test asking for it")),
      publish: () => Promise.reject(new Error("listed a print without a test asking for it")),
      quote: () =>
        Promise.reject(new Error("asked Printful for a price without a test asking for it")),
      readFile: () =>
        Promise.reject(new Error("fetched a print file without a test asking for it")),
      stripeAccess: () =>
        Promise.reject(new Error("asked Stripe about its grants without a test asking for it")),
    },
    productionHosts: () =>
      Promise.reject(new Error("asked Vercel for domains without a test asking for it")),
    run: { betId: null, origin: "founder", productId: null, runId: "run", taskId: "task" },
    setEnv: () => Promise.reject(new Error("set a variable without a test asking for it")),
  };
  return { asked, assigned, company, ctx };
};

export const BET = {
  budgetUsd: 3,
  hypothesis: "a post brings visitors",
  metric: "users",
  target: 50,
  title: "Launch post",
  windowHours: 48,
};

export const openBet = async (ctx: RunContext) => {
  await callTool(ctx, "open_bet", BET);
  const [bet] = store.listBets();
  if (!bet) {
    throw new Error("no bet opened");
  }
  return bet;
};

export const HANDOFF = { description: "write it", role: "engineer", title: "Draft the post" };

export const TOKEN = "vercel-secret-token";
export const VERCEL = { projectId: "prj_1", projectName: "acme-site", teamId: "team_1" };
export const BOUND_ACTION = "deploy acme to production on Vercel project acme-site";
export const DEPLOYED: Extract<DeployResult, { kind: "deployed" }> = {
  alias: null,
  kind: "deployed",
  project: VERCEL,
  url: "https://acme-1.vercel.app",
};

/** A run of Priya's on Acme whose deploys answer `result`, and what each deploy was asked. */
export const deployingRun = (result: DeployResult) => {
  const run = runAs("priya");
  const deploys: DeployRequest[] = [];
  const ctx: RunContext = {
    ...run.ctx,
    checkVercelToken: () => Promise.resolve({ account: "kai", kind: "valid" }),
    deploy: (req) => {
      deploys.push(req);
      return Promise.resolve(result);
    },
    run: { ...run.ctx.run, productId: "acme" },
  };
  return { ...run, ctx, deploys };
};

export const connectVercel = () =>
  writeFileSync(path.join(root, "secrets.json"), JSON.stringify({ VERCEL_TOKEN: TOKEN }));

export const PAID_URL = "https://buy.stripe.com/pro";

/** The link create_payment_link keeps for "Pro plan" at $9 on Acme. */
export const PRO_LINK: ChargeLink = {
  betId: null,
  cents: 900,
  createdAt: 1,
  delivery: null,
  id: "plink_pro",
  livemode: true,
  name: "Pro plan",
  productId: "acme",
  state: { kind: "selling" },
  url: PAID_URL,
};

export interface StripeAnswer {
  status: number;
  body: JsonValue;
}

/**
 * Stripe behind its idempotency layer: the first answer to a key, a failure too, is what every
 * later request with that key gets back, marked replayed. A request carrying no key goes to
 * `elsewhere`.
 */
export const replayingStripe = (
  answer: (endpoint: string) => StripeAnswer,
  elsewhere: (url: string, init: RequestInit) => Promise<Response> = () =>
    Promise.reject(new Error("only Stripe answers")),
) => {
  const answered = new Map<string, StripeAnswer>();
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    const key = new Headers(init.headers).get("Idempotency-Key");
    if (key === null) {
      return elsewhere(url, init);
    }
    const replay = answered.get(key);
    if (replay !== undefined) {
      return Promise.resolve(
        Response.json(replay.body, {
          headers: { "Idempotent-Replayed": "true" },
          status: replay.status,
        }),
      );
    }
    const fresh = answer(new URL(url).pathname);
    answered.set(key, fresh);
    return Promise.resolve(Response.json(fresh.body, { status: fresh.status }));
  });
};

export const revenueBet = (productId = "acme") =>
  store.openBet({ ...BET, metric: "revenue", productId, target: 20, title: "Paid tier" });

/** The print file the product's site serves, and its digest, which the founder signs for. */
export const DESIGN = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]);
export const DESIGN_SHA = createHash("sha256").update(DESIGN).digest("hex");
export const LISTED_URL = "https://buy.stripe.com/tee";
