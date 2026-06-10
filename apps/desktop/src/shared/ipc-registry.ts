import { z } from "zod";
import { CHANNELS, type IpcMethod, type IpcKind } from "@/shared/ipc-channels";
import type { ActivityEvent, Company, Employee, Task } from "@/shared/domain";

export { CHANNELS };
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

/** A composited character: base64 PNG data URLs ready for Phaser/<img>. */
export type CharacterAssets = {
  seed: string;
  walkSheetDataUrl: string; // 192x256 PNG, 32x64 frames (down 0-5, left 6-11, right 12-17, up 18-23)
  portraitDataUrl: string; // 64x64 PNG
  parts: {
    premadeIndex: number; // 1..N — which Limezu premade sheet this character uses
  };
};

// ---- zod payload schemas (validation in main; keyed by method) --------------
const CreateCompanySchema = z.object({
  name: z.string(),
  mission: z.string(),
  founderName: z.string(),
  founderSpriteSeed: z.string(),
});
const CreateEmployeeSchema = z.object({
  companyId: z.string(),
  name: z.string(),
  role: z.string(),
  title: z.string(),
  persona: z.string(),
  spriteSeed: z.string(),
  deskIndex: z.number().int(),
  model: z.string().optional(),
  thinking: z.string().optional(),
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
  createEmployee: CreateEmployeeSchema,
  listTasks: z.object({ companyId: z.string() }),
  createTask: CreateTaskSchema,
  assignTask: z.object({ taskId: z.string(), employeeId: z.string() }),
  submitAuthCode: z.object({ code: z.string() }),
  answerQuestion: z.object({ taskId: z.string(), answer: z.string() }),
  openCompanyPath: z.object({ companyId: z.string(), rel: z.string() }),
  openProduct: z.object({ companyId: z.string() }),
  generateHires: z.object({ companyName: z.string(), mission: z.string() }),
  batchHire: z.object({ companyId: z.string(), hires: z.array(HireProposalSchema) }),
  completeOnboarding: z.object({ companyId: z.string() }),
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
  generateHires: { payload: { companyName: string; mission: string }; result: HireProposal[] };
  batchHire: { payload: { companyId: string; hires: HireProposal[] }; result: Employee[] };
  completeOnboarding: { payload: { companyId: string }; result: Company };

  getCompany: { payload: void; result: Company | null };
  createCompany: { payload: z.infer<typeof CreateCompanySchema>; result: Company };
  setAutopilot: { payload: { companyId: string; running: boolean }; result: Company };

  listEmployees: { payload: { companyId: string }; result: Employee[] };
  createEmployee: { payload: z.infer<typeof CreateEmployeeSchema>; result: Employee };

  listTasks: { payload: { companyId: string }; result: Task[] };
  createTask: { payload: z.infer<typeof CreateTaskSchema>; result: Task };
  assignTask: { payload: { taskId: string; employeeId: string }; result: Task };
  answerQuestion: { payload: { taskId: string; answer: string }; result: Task };
  openCompanyPath: { payload: { companyId: string; rel: string }; result: { ok: boolean } };
  openProduct: { payload: { companyId: string }; result: { ok: boolean; opened: string } };

  onActivity: { payload: void; result: ActivityEvent };
}

// compile-time guarantee: Contract keys == channel keys
type _AssertContractCoversChannels = IpcMethod extends keyof Contract ? true : never;
type _AssertChannelsCoverContract = keyof Contract extends IpcMethod ? true : never;
const _contractCheck: _AssertContractCoversChannels & _AssertChannelsCoverContract = true;
void _contractCheck;

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
