import { z } from "zod";
import type { IpcMethod, IpcKind } from "@/shared/ipc-channels";
import type {
  ActivityEvent,
  Budget,
  BusinessTypeId,
  Company,
  Employee,
  Task,
  Team,
  TeamMessage,
} from "@/shared/domain";

export type { IpcMethod };

// ---- shared domain types ---------------------------------------------------
/** Streamed steps of the in-game OpenAI OAuth flow. */
export type AuthFlowEvent =
  | { type: "url"; url: string; instructions: string }
  | { type: "progress"; message: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** An LLM-proposed hire (pre-employment; spriteSeed assigned by main). */
export type HireProposal = {
  name: string;
  role: string;
  title: string;
  persona: string;
  blurb: string;
  spriteSeed: string;
};

/** A founder appearance option for onboarding. */
export type FounderChoice = { seed: string; portraitDataUrl: string };

/** Stripe Connect link state, streamed to the renderer. */
export type StripeStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected"; accountId: string; livemode: boolean }
  | { state: "error"; message: string };

/** Vercel link state (token-based; no OAuth). */
export type VercelStatus =
  | { state: "disconnected" }
  | { state: "connected"; projectId: string; projectName: string };

/** A Vercel project the founder can bind the company to. */
export type VercelProjectChoice = { id: string; name: string; teamId?: string };

/** The product panel's real-world state. */
export type ProductStatus = {
  ships: number;
  /** PRODUCT.md `entry:` value (path or URL), if the team wrote one. */
  entry: string | null;
  /** Latest production deployment when Vercel is connected. */
  deploy: { url: string; state: string; createdAt: number } | null;
};

/** A composited character: base64 PNG data URLs ready for Phaser/<img>. */
export type CharacterAssets = {
  seed: string;
  walkSheetDataUrl: string; // 192x256 PNG, 32x64 frames (down 0-5, left 6-11, right 12-17, up 18-23)
  portraitDataUrl: string; // 64x64 PNG
  parts: {
    sheetIndex: number; // 1..N — which bundled employee sheet this character uses
  };
};

// ---- zod payload schemas (validation in main; keyed by method) --------------
const BusinessTypeSchema = z.enum(["software", "game-studio", "vc", "ecommerce", "custom"]);
// compile-time guarantee: the zod enum and the domain union stay in sync
type _AssertBizSchemaCoversDomain =
  BusinessTypeId extends z.infer<typeof BusinessTypeSchema> ? true : never;
type _AssertBizDomainCoversSchema =
  z.infer<typeof BusinessTypeSchema> extends BusinessTypeId ? true : never;
const bizSchemaInSync: _AssertBizSchemaCoversDomain & _AssertBizDomainCoversSchema = true;
void bizSchemaInSync;

const BudgetSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("infinite") }),
  z.object({ mode: z.literal("capped"), capUsd: z.number().nonnegative() }),
]);
type _AssertBudgetSchema =
  Budget extends z.infer<typeof BudgetSchema>
    ? z.infer<typeof BudgetSchema> extends Budget
      ? true
      : never
    : never;
const budgetSchemaInSync: _AssertBudgetSchema = true;
void budgetSchemaInSync;

const CreateCompanySchema = z.object({
  name: z.string(),
  mission: z.string(),
  businessType: BusinessTypeSchema,
  founderName: z.string(),
  founderSpriteSeed: z.string(),
});
const CreateTaskSchema = z.object({
  companyId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  assigneeId: z.string().optional(),
});

const HireProposalSchema = z.object({
  name: z.string(),
  role: z.string(),
  title: z.string(),
  persona: z.string(),
  blurb: z.string(),
  spriteSeed: z.string(),
});

export const SCHEMAS = {
  composeCharacter: z.object({ seed: z.string() }),
  createCompany: CreateCompanySchema,
  setAutopilot: z.object({ companyId: z.string(), running: z.boolean() }),
  listEmployees: z.object({ companyId: z.string() }),
  listTeams: z.object({ companyId: z.string() }),
  teamMessages: z.object({ teamId: z.string(), limit: z.number().int().optional() }),
  postTeamChat: z.object({ teamId: z.string(), text: z.string().min(1).max(2000) }),
  setMaxAgents: z.object({ companyId: z.string(), maxAgents: z.number().int().min(1).max(64) }),
  listTasks: z.object({ companyId: z.string() }),
  createTask: CreateTaskSchema,
  assignTask: z.object({ taskId: z.string(), employeeId: z.string() }),
  submitAuthCode: z.object({ code: z.string() }),
  answerQuestion: z.object({ taskId: z.string(), answer: z.string() }),
  openCompanyPath: z.object({ companyId: z.string(), rel: z.string() }),
  openProduct: z.object({ companyId: z.string() }),
  generateHires: z.object({
    companyName: z.string(),
    mission: z.string(),
    businessType: BusinessTypeSchema,
  }),
  batchHire: z.object({ companyId: z.string(), hires: z.array(HireProposalSchema) }),
  completeOnboarding: z.object({ companyId: z.string() }),
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

// ---- per-method contract: payload + result/event types ---------------------
// Every method appears here exactly once. payload is `void` for invoke-void.
export interface Contract {
  hasAuth: { payload: void; result: { ok: boolean } };
  startLogin: { payload: void; result: { started: boolean } };
  submitAuthCode: { payload: { code: string }; result: { accepted: boolean } };
  onAuthEvent: { payload: void; result: AuthFlowEvent };
  composeCharacter: { payload: { seed: string }; result: CharacterAssets };
  getFounderChoices: { payload: void; result: FounderChoice[] };
  generateHires: {
    payload: { companyName: string; mission: string; businessType: BusinessTypeId };
    result: HireProposal[];
  };
  batchHire: { payload: { companyId: string; hires: HireProposal[] }; result: Employee[] };
  completeOnboarding: { payload: { companyId: string }; result: Company };

  getCompany: { payload: void; result: Company | null };
  createCompany: { payload: z.infer<typeof CreateCompanySchema>; result: Company };
  setAutopilot: { payload: { companyId: string; running: boolean }; result: Company };
  setBudget: { payload: { companyId: string; budget: Budget }; result: Company };
  resetSpend: { payload: { companyId: string }; result: Company };

  resetGame: { payload: void; result: { ok: boolean } };

  stripeStatus: { payload: void; result: StripeStatus };
  stripeConnect: { payload: { companyId: string }; result: { started: boolean } };
  stripeDisconnect: { payload: { companyId: string }; result: { ok: boolean } };
  onStripeStatus: { payload: void; result: StripeStatus };

  vercelStatus: { payload: void; result: VercelStatus };
  vercelListProjects: {
    payload: { token: string };
    result: { ok: boolean; account?: string; projects: VercelProjectChoice[] };
  };
  vercelConnect: {
    payload: {
      companyId: string;
      token: string;
      projectId: string;
      projectName: string;
      teamId?: string;
    };
    result: { ok: boolean };
  };
  vercelDisconnect: { payload: { companyId: string }; result: { ok: boolean } };
  productStatus: { payload: { companyId: string }; result: ProductStatus };

  listEmployees: { payload: { companyId: string }; result: Employee[] };

  listTeams: { payload: { companyId: string }; result: Team[] };
  teamMessages: { payload: { teamId: string; limit?: number }; result: TeamMessage[] };
  postTeamChat: { payload: { teamId: string; text: string }; result: { ok: boolean } };
  setMaxAgents: { payload: { companyId: string; maxAgents: number }; result: Company };

  listTasks: { payload: { companyId: string }; result: Task[] };
  createTask: { payload: z.infer<typeof CreateTaskSchema>; result: Task };
  assignTask: { payload: { taskId: string; employeeId: string }; result: Task };
  answerQuestion: { payload: { taskId: string; answer: string }; result: Task };
  openCompanyPath: { payload: { companyId: string; rel: string }; result: { ok: boolean } };
  openProduct: { payload: { companyId: string }; result: { ok: boolean; opened: string } };

  onActivity: { payload: void; result: ActivityEvent };

  saveOfficeDesign: { payload: { json: string }; result: { ok: boolean } };
  loadOfficeDesign: { payload: void; result: { layout: unknown } };
}

// compile-time guarantee: Contract keys == channel keys
type _AssertContractCoversChannels = IpcMethod extends keyof Contract ? true : never;
type _AssertChannelsCoverContract = keyof Contract extends IpcMethod ? true : never;
const contractInSync: _AssertContractCoversChannels & _AssertChannelsCoverContract = true;
void contractInSync;

// ---- derived: renderer-facing bridge shape ---------------------------------
export type AppBridge = {
  [M in IpcMethod]: IpcKind<M> extends "invoke-void"
    ? () => Promise<Contract[M]["result"]>
    : IpcKind<M> extends "invoke"
      ? (payload: Contract[M]["payload"]) => Promise<Contract[M]["result"]>
      : IpcKind<M> extends "send"
        ? (payload: Contract[M]["payload"]) => void
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
      : IpcKind<M> extends "send"
        ? (payload: Contract[M]["payload"]) => void
        : never;
