import { z } from "zod";
import type { IpcMethod, IpcKind, InvokeMethod } from "@/shared/ipc-channels";
import type { ActivityEvent } from "@/shared/activity";
import type { Bet } from "@/shared/bets";
import type { Digest } from "@/shared/digest";
import {
  BudgetSchema,
  KillReasonSchema,
  MaxAgentsSchema,
  OPEN_TASK_STATUSES,
  ProductDraftSchema,
} from "@/shared/domain";
import type {
  AuthFlowEvent,
  CharacterAssets,
  ChatOption,
  Company,
  Employee,
  LoadReport,
  Product,
  RestingRunners,
  ShipLine,
  Task,
  TeamMessage,
} from "@/shared/domain";
import { BusinessTypeSchema, HireProposalSchema } from "@/shared/hire";
import type { HireProposal } from "@/shared/hire";
import type {
  ProductStatus,
  StripeKeyStatus,
  StripeStatus,
  VercelListing,
} from "@/shared/integrations";
import { officeLayoutSchema } from "@/shared/office-layout-schema";
import type { OfficeDesign } from "@/shared/office-layout-schema";

/** A call that answers nothing: it worked, or it threw. */
// oxlint-disable-next-line typescript/no-invalid-void-type -- the values of Results are handler return types, which the rule cannot see through the map
type Done = void;

/**
 * A Vercel token the founder pasted. Left out, the saved one is used: it serves
 * every product, so replacing it for one could cut another off.
 */
const VercelTokenSchema = z.string().trim().min(1);

export const SCHEMAS = {
  answerQuestion: z.object({ answer: z.string(), taskId: z.string() }),
  assignTask: z.object({ employeeId: z.string(), taskId: z.string() }),
  composeCharacter: z.object({ seed: z.string() }),
  createProduct: ProductDraftSchema,
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
  getFounderChoices: z.void(),
  hasAuth: z.void(),
  killBet: z.object({ betId: z.string(), reason: KillReasonSchema }),
  killProduct: z.object({ productId: z.string(), reason: KillReasonSchema }),
  listBets: z.void(),
  listEmployees: z.void(),
  listProducts: z.void(),
  listTasks: z.object({
    assigneeId: z.string().optional(),
    status: z.array(z.enum(OPEN_TASK_STATUSES)).optional(),
  }),
  loadOfficeDesign: z.void(),
  loadReport: z.void(),
  openCompanyPath: z.object({ rel: z.string() }),
  openProduct: z.object({ productId: z.string() }),
  openSaveFolder: z.void(),
  postTeamChat: z.object({ text: z.string().min(1).max(2000) }),
  productStatus: z.object({ productId: z.string() }),
  resetGame: z.void(),
  resetSpend: z.void(),
  resolveApproval: z.object({ approved: z.boolean(), taskId: z.string() }),
  restingRunners: z.void(),
  saveOfficeDesign: z.object({ layout: officeLayoutSchema }),
  setAutopilot: z.object({ running: z.boolean() }),
  setBudget: z.object({ budget: BudgetSchema }),
  setMaxAgents: z.object({ maxAgents: MaxAgentsSchema }),
  shippingLog: z.void(),
  startLogin: z.void(),
  stripeConnect: z.void(),
  stripeDisconnect: z.void(),
  stripeKeyRemove: z.void(),
  stripeKeySave: z.object({ key: z.string().trim().min(1) }),
  stripeKeyStatus: z.void(),
  stripeStatus: z.void(),
  takeDigest: z.void(),
  teamMessages: z.object({ limit: z.number().int().optional() }),
  vercelConnect: z.object({
    productId: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    teamId: z.string().optional(),
    token: VercelTokenSchema.optional(),
  }),
  vercelDisconnect: z.object({ productId: z.string() }),
  vercelListProjects: z.object({ token: VercelTokenSchema.optional() }),
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
  loadReport: LoadReport;
  openSaveFolder: Done;
  setAutopilot: Company;
  setBudget: Company;
  resetSpend: Company;

  resetGame: Done;

  stripeStatus: StripeStatus;
  stripeConnect: { started: boolean };
  stripeDisconnect: Done;
  onStripeStatus: StripeStatus;
  stripeKeyStatus: StripeKeyStatus;
  stripeKeySave: Done;
  stripeKeyRemove: Done;

  takeDigest: Digest | null;
  vercelListProjects: VercelListing;
  vercelConnect: Done;
  vercelDisconnect: Done;
  listProducts: Product[];
  createProduct: Product;
  productStatus: ProductStatus;
  killProduct: Product;
  listBets: Bet[];
  killBet: Bet;

  listEmployees: Employee[];
  restingRunners: RestingRunners;

  teamMessages: TeamMessage[];
  employeeOptions: ChatOption[];
  postTeamChat: Done;
  directEmployee: Done;
  setMaxAgents: Company;

  listTasks: Task[];
  shippingLog: ShipLine[];
  assignTask: Task;
  answerQuestion: Task;
  resolveApproval: Task;
  openCompanyPath: Done;
  openProduct: { opened: string };

  onActivity: ActivityEvent;

  saveOfficeDesign: Done;
  loadOfficeDesign: OfficeDesign;
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
