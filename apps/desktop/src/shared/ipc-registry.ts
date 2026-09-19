import { z } from "zod";
import type { IpcMethod, IpcKind, InvokeMethod } from "@/shared/ipc-channels";
import type { JsonValue } from "@/shared/json";
import type { ActivityEvent } from "@/shared/activity";
import { BUSINESS_TYPE_IDS, BudgetSchema, TASK_STATUSES } from "@/shared/domain";
import type { AgentRunner, Company, Employee, Product, Task, TeamMessage } from "@/shared/domain";

/** Streamed steps of the workforce setup flow (CLI detect/install/login). */
export type AuthFlowEvent =
  | { type: "url"; url: string }
  | { type: "progress"; message: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** runner → epoch its usage limit lifts, for every runner currently parked. */
export type RestingRunners = Partial<Record<AgentRunner, number>>;

/** A package on disk the store could not read at boot, and why. */
export interface LoadSkip {
  kind: "company" | "employee" | "task" | "routine" | "product" | "team";
  path: string;
  error: string;
}
/** What boot found under ~/.idlebiz: how many companies loaded, and what it had to leave out. */
export interface LoadReport {
  companies: number;
  skipped: LoadSkip[];
}

/** How many ship lines the digest keeps and its window lists. */
export const DIGEST_SHIPS_SHOWN = 5;

/** What happened while the founder was away: folded from each event as it
 *  is published, so an absence of any length is counted in full. */
export const DigestSchema = z.object({
  /** Tasks that gave up while they were away. */
  dead: z.number(),
  hired: z.array(z.string()),
  released: z.array(z.string()),
  runs: z.number(),
  /** How many shipped; `ships` holds only the latest few of them. */
  shipped: z.number(),
  /** The latest ship summaries, oldest first: at most DIGEST_SHIPS_SHOWN. */
  ships: z.array(z.string()),
  since: z.number(),
  spentUsd: z.number(),
});
export type Digest = z.infer<typeof DigestSchema>;

/** Stripe Connect link state, streamed to the renderer. */
export type StripeStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected"; accountId: string; livemode: boolean }
  | { state: "error"; message: string };

/** A Vercel project the founder can bind the company to. */
export interface VercelProject {
  id: string;
  name: string;
  teamId?: string;
}

/** The latest production deployment of the bound Vercel project. */
export interface VercelDeployment {
  url: string;
  state: string;
  createdAt: number;
}

export interface ProductStatus {
  /** PRODUCT.md `entry:` value (path or URL), if the team wrote one. */
  entry: string | null;
  /** Latest production deployment when Vercel is connected. */
  deploy: VercelDeployment | null;
}

/** One thing the founder can ask an employee from the battle box: the label shown, the brief sent. */
export interface ChatOption {
  label: string;
  instruction: string;
}

/** A composited character: base64 PNG data URLs ready for Phaser/<img>. */
export interface CharacterAssets {
  /** 192x384 PNG, 32x64 frames: walk down/left/right/up, sit-left, sit-right */
  walkSheetDataUrl: string;
  /** 44x44 PNG: the drawn head-and-shoulders bust */
  bustDataUrl: string;
}

const BusinessTypeSchema = z.enum(BUSINESS_TYPE_IDS);

/** An LLM-proposed hire, as cast: the shape the roster generator must produce. */
export const HireCandidateSchema = z.object({
  blurb: z.string().min(2).max(120),
  name: z.string().min(1).max(40),
  persona: z.string().min(10).max(600),
  role: z
    .string()
    .min(2)
    .max(32)
    .transform((s) => s.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")),
  title: z.string().min(2).max(60),
});
export type HireCandidate = z.infer<typeof HireCandidateSchema>;
/** A candidate the founder can hire: main has given them a look. */
const HireProposalSchema = HireCandidateSchema.extend({ spriteSeed: z.string() });
export type HireProposal = z.infer<typeof HireProposalSchema>;

export const SCHEMAS = {
  answerQuestion: z.object({ answer: z.string(), taskId: z.string() }),
  assignTask: z.object({ employeeId: z.string(), taskId: z.string() }),
  composeCharacter: z.object({ seed: z.string() }),
  createProduct: z.object({
    companyId: z.string(),
    description: z.string().trim().min(1).max(600),
    name: z.string().trim().min(1).max(80),
  }),
  directEmployee: z.object({ employeeId: z.string(), instruction: z.string().min(1).max(2000) }),
  employeeOptions: z.object({ employeeId: z.string() }),
  foundCompany: z.object({
    // Set the cap at creation; the scheduler can spend on its first tick.
    budget: BudgetSchema,
    businessType: BusinessTypeSchema,
    founderName: z.string(),
    founderSpriteSeed: z.string(),
    hires: z.array(HireProposalSchema).min(1),
    mission: z.string(),
    name: z.string(),
  }),
  generateHires: z.object({
    businessType: BusinessTypeSchema,
    companyName: z.string(),
    mission: z.string(),
  }),
  getCompany: z.void(),
  getDigest: z.object({ companyId: z.string() }),
  getFounderChoices: z.void(),
  hasAuth: z.void(),
  listEmployees: z.object({ companyId: z.string() }),
  listProducts: z.object({ companyId: z.string() }),
  listTasks: z.object({
    assigneeId: z.string().optional(),
    companyId: z.string(),
    status: z.array(z.enum(TASK_STATUSES)).optional(),
  }),
  loadOfficeDesign: z.void(),
  loadReport: z.void(),
  openCompanyPath: z.object({ companyId: z.string(), rel: z.string() }),
  openProduct: z.object({ productId: z.string() }),
  openSaveFolder: z.void(),
  postTeamChat: z.object({ companyId: z.string(), text: z.string().min(1).max(2000) }),
  productStatus: z.object({ productId: z.string() }),
  resetGame: z.void(),
  resetSpend: z.object({ companyId: z.string() }),
  resolveApproval: z.object({ approved: z.boolean(), taskId: z.string() }),
  restingRunners: z.void(),
  saveOfficeDesign: z.object({ json: z.string() }),
  setAutopilot: z.object({ companyId: z.string(), running: z.boolean() }),
  setBudget: z.object({ budget: BudgetSchema, companyId: z.string() }),
  setMaxAgents: z.object({ companyId: z.string(), maxAgents: z.number().int().min(1).max(64) }),
  startLogin: z.void(),
  stripeConnect: z.object({ companyId: z.string() }),
  stripeDisconnect: z.object({ companyId: z.string() }),
  stripeStatus: z.void(),
  teamMessages: z.object({ companyId: z.string(), limit: z.number().int().optional() }),
  vercelConnect: z.object({
    productId: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    teamId: z.string().optional(),
    token: z.string(),
  }),
  vercelDisconnect: z.object({ productId: z.string() }),
  vercelListProjects: z.object({ token: z.string() }),
} satisfies {
  [M in InvokeMethod]: IpcKind<M> extends "invoke-void" ? z.ZodType<void> : z.ZodType;
};

// A method's payload IS its schema's output; only results are declared here,
// once per method (events list what they carry as their result).
interface Results {
  hasAuth: { ok: boolean };
  startLogin: { started: boolean };
  onAuthEvent: AuthFlowEvent;
  composeCharacter: CharacterAssets;
  /** Sprite seeds the founder may pick a look from. */
  getFounderChoices: string[];
  generateHires: HireProposal[];
  foundCompany: Company;

  getCompany: Company | null;
  /** Null before the founder's first look, or without a company. */
  getDigest: Digest | null;
  loadReport: LoadReport;
  openSaveFolder: { ok: boolean };
  setAutopilot: Company;
  setBudget: Company;
  resetSpend: Company;

  resetGame: { ok: boolean };

  stripeStatus: StripeStatus;
  stripeConnect: { started: boolean };
  stripeDisconnect: { ok: boolean };
  onStripeStatus: StripeStatus;

  vercelListProjects: { ok: boolean; account?: string; projects: VercelProject[] };
  vercelConnect: { ok: boolean };
  vercelDisconnect: { ok: boolean };
  listProducts: Product[];
  createProduct: Product;
  productStatus: ProductStatus;

  listEmployees: Employee[];
  restingRunners: RestingRunners;

  teamMessages: TeamMessage[];
  employeeOptions: ChatOption[];
  postTeamChat: { ok: boolean };
  directEmployee: { ok: boolean };
  setMaxAgents: Company;

  listTasks: Task[];
  assignTask: Task;
  answerQuestion: Task;
  resolveApproval: Task;
  openCompanyPath: { ok: boolean };
  openProduct: { ok: boolean; opened: string };

  onActivity: ActivityEvent;

  saveOfficeDesign: { ok: boolean };
  loadOfficeDesign: { layout: JsonValue | null };
}

type Payload<M extends IpcMethod> = M extends keyof typeof SCHEMAS
  ? z.infer<(typeof SCHEMAS)[M]>
  : undefined;

export type Contract = { [M in IpcMethod]: { payload: Payload<M>; result: Results[M] } };

// compile-time guarantee: every result names a channel (the reverse is checked by Contract itself)
type _AssertResultsAreChannels = Exclude<keyof Results, IpcMethod> extends never ? true : never;
const resultsInSync: _AssertResultsAreChannels = true;
void resultsInSync;

export type AppBridge = {
  [M in IpcMethod]: IpcKind<M> extends "invoke-void"
    ? () => Promise<Contract[M]["result"]>
    : IpcKind<M> extends "invoke"
      ? (payload: Contract[M]["payload"]) => Promise<Contract[M]["result"]>
      : IpcKind<M> extends "event"
        ? (listener: (e: Contract[M]["result"]) => void) => () => void
        : never;
};

export type IpcHandler<M extends InvokeMethod> = (
  payload: Contract[M]["payload"],
) => Contract[M]["result"] | Promise<Contract[M]["result"]>;
