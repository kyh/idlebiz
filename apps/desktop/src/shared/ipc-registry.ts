import { z } from "zod";
import type { IpcMethod, IpcKind } from "@/shared/ipc-channels";
import type { JsonValue } from "@/shared/json";
import type { ActivityEvent } from "@/shared/activity";
import {
  BUSINESS_TYPE_IDS,
  BudgetSchema,
  TASK_STATUSES,
  type AgentRunner,
  type Company,
  type Employee,
  type Task,
  type Team,
  type TeamMessage,
} from "@/shared/domain";

export type { IpcMethod };

// ---- shared domain types ---------------------------------------------------
/** Streamed steps of the workforce setup flow (CLI detect/install/login). */
export type AuthFlowEvent =
  | { type: "url"; url: string }
  | { type: "progress"; message: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** runner → epoch its usage limit lifts, for every runner currently parked. */
export type RestingRunners = Partial<Record<AgentRunner, number>>;

/** A package on disk the store could not read at boot, and why. */
export type LoadSkip = {
  kind: "company" | "employee" | "task" | "routine" | "team";
  path: string;
  error: string;
};
/** What boot found under ~/.idlebiz: how many companies loaded, and what it had to leave out. */
export type LoadReport = { companies: number; skipped: LoadSkip[] };

/** A founder appearance option for onboarding. */
export type FounderChoice = { seed: string; portraitDataUrl: string };

/** Stripe Connect link state, streamed to the renderer. */
export type StripeStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected"; accountId: string; livemode: boolean }
  | { state: "error"; message: string };

/** Vercel link state (token-based; no OAuth). */
export type VercelStatus = { state: "disconnected" } | { state: "connected"; projectName: string };

/** A Vercel project the founder can bind the company to. */
export type VercelProject = { id: string; name: string; teamId?: string };

/** The latest production deployment of the bound Vercel project. */
export type VercelDeployment = { url: string; state: string; createdAt: number };

/** The product panel's real-world state. */
export type ProductStatus = {
  /** PRODUCT.md `entry:` value (path or URL), if the team wrote one. */
  entry: string | null;
  /** Latest production deployment when Vercel is connected. */
  deploy: VercelDeployment | null;
};

/** A composited character: base64 PNG data URLs ready for Phaser/<img>. */
export type CharacterAssets = {
  walkSheetDataUrl: string; // 192x384 PNG, 32x64 frames: walk down/left/right/up, sit-left, sit-right
  portraitDataUrl: string; // 64x64 PNG
};

// ---- zod payload schemas (validation in main; keyed by method) --------------
const BusinessTypeSchema = z.enum(BUSINESS_TYPE_IDS);

/** An LLM-proposed hire, as cast: the shape the roster generator must produce. */
export const HireCandidateSchema = z.object({
  name: z.string().min(1).max(40),
  role: z
    .string()
    .min(2)
    .max(32)
    .transform((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
  title: z.string().min(2).max(60),
  persona: z.string().min(10).max(600),
  blurb: z.string().min(2).max(120),
});
export type HireCandidate = z.infer<typeof HireCandidateSchema>;
/** A candidate the founder can hire: main has given them a look. */
const HireProposalSchema = HireCandidateSchema.extend({ spriteSeed: z.string() });
export type HireProposal = z.infer<typeof HireProposalSchema>;

export const SCHEMAS = {
  composeCharacter: z.object({ seed: z.string() }),
  foundCompany: z.object({
    name: z.string(),
    mission: z.string(),
    businessType: BusinessTypeSchema,
    founderName: z.string(),
    founderSpriteSeed: z.string(),
    // the company is born with its cap: agents run on real paid CLI calls, and a
    // company that exists uncapped for even one scheduler tick can spend
    budget: BudgetSchema,
    hires: z.array(HireProposalSchema).min(1),
  }),
  setAutopilot: z.object({ companyId: z.string(), running: z.boolean() }),
  listEmployees: z.object({ companyId: z.string() }),
  listTeams: z.object({ companyId: z.string() }),
  teamMessages: z.object({ teamId: z.string(), limit: z.number().int().optional() }),
  postTeamChat: z.object({ teamId: z.string(), text: z.string().min(1).max(2000) }),
  directEmployee: z.object({ employeeId: z.string(), instruction: z.string().min(1).max(2000) }),
  setMaxAgents: z.object({ companyId: z.string(), maxAgents: z.number().int().min(1).max(64) }),
  listTasks: z.object({
    companyId: z.string(),
    assigneeId: z.string().optional(),
    status: z.array(z.enum(TASK_STATUSES)).optional(),
  }),
  assignTask: z.object({ taskId: z.string(), employeeId: z.string() }),
  answerQuestion: z.object({ taskId: z.string(), answer: z.string() }),
  resolveApproval: z.object({ taskId: z.string(), approved: z.boolean() }),
  openCompanyPath: z.object({ companyId: z.string(), rel: z.string() }),
  openProduct: z.object({ companyId: z.string() }),
  generateHires: z.object({
    companyName: z.string(),
    mission: z.string(),
    businessType: BusinessTypeSchema,
  }),
  setBudget: z.object({ companyId: z.string(), budget: BudgetSchema }),
  resetSpend: z.object({ companyId: z.string() }),
  stripeConnect: z.object({ companyId: z.string() }),
  stripeDisconnect: z.object({ companyId: z.string() }),
  vercelListProjects: z.object({ token: z.string() }),
  vercelConnect: z.object({
    companyId: z.string(),
    token: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    teamId: z.string().optional(),
  }),
  vercelDisconnect: z.object({ companyId: z.string() }),
  productStatus: z.object({ companyId: z.string() }),
  saveOfficeDesign: z.object({ json: z.string() }),
} satisfies Partial<Record<IpcMethod, z.ZodTypeAny>>;

// ---- per-method contract -----------------------------------------------------
// A method's payload IS its schema's output; only results are declared here,
// once per method (events list what they carry as their result).
interface Results {
  hasAuth: { ok: boolean };
  startLogin: { started: boolean };
  onAuthEvent: AuthFlowEvent;
  composeCharacter: CharacterAssets;
  getFounderChoices: FounderChoice[];
  generateHires: HireProposal[];
  foundCompany: Company;

  getCompany: Company | null;
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

  vercelStatus: VercelStatus;
  vercelListProjects: { ok: boolean; account?: string; projects: VercelProject[] };
  vercelConnect: { ok: boolean };
  vercelDisconnect: { ok: boolean };
  productStatus: ProductStatus;

  listEmployees: Employee[];
  restingRunners: RestingRunners;

  listTeams: Team[];
  teamMessages: TeamMessage[];
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
  : void;

export type Contract = { [M in IpcMethod]: { payload: Payload<M>; result: Results[M] } };

// compile-time guarantee: every result names a channel (the reverse is checked by Contract itself)
type _AssertResultsAreChannels = Exclude<keyof Results, IpcMethod> extends never ? true : never;
const resultsInSync: _AssertResultsAreChannels = true;
void resultsInSync;

// ---- derived: renderer-facing bridge shape ---------------------------------
export type AppBridge = {
  [M in IpcMethod]: IpcKind<M> extends "invoke-void"
    ? () => Promise<Contract[M]["result"]>
    : IpcKind<M> extends "invoke"
      ? (payload: Contract[M]["payload"]) => Promise<Contract[M]["result"]>
      : IpcKind<M> extends "event"
        ? (listener: (e: Contract[M]["result"]) => void) => () => void
        : never;
};

// ---- derived: handler signature main must implement ------------------------
export type IpcHandler<M extends IpcMethod> =
  IpcKind<M> extends "invoke-void"
    ? () => Contract[M]["result"] | Promise<Contract[M]["result"]>
    : IpcKind<M> extends "invoke"
      ? (payload: Contract[M]["payload"]) => Contract[M]["result"] | Promise<Contract[M]["result"]>
      : never;
