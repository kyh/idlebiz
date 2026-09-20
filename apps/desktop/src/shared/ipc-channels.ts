// No runtime imports: the sandboxed preload can only require Electron.
// Schemas and typed contracts live in ipc-registry.ts.

export const CHANNELS = {
  answerQuestion: { channel: "task:answer", kind: "invoke" },
  assignTask: { channel: "task:assign", kind: "invoke" },
  composeCharacter: { channel: "char:compose", kind: "invoke" },
  createProduct: { channel: "product:create", kind: "invoke" },
  directEmployee: { channel: "employee:direct", kind: "invoke" },
  employeeOptions: { channel: "employee:options", kind: "invoke" },
  foundCompany: { channel: "onboard:found", kind: "invoke" },
  generateHires: { channel: "onboard:hires", kind: "invoke" },
  getCompany: { channel: "company:get", kind: "invoke-void" },
  getFounderChoices: { channel: "char:founders", kind: "invoke-void" },
  hasAuth: { channel: "agent:hasAuth", kind: "invoke-void" },
  killBet: { channel: "bet:kill", kind: "invoke" },
  killProduct: { channel: "product:kill", kind: "invoke" },
  listBets: { channel: "bet:list", kind: "invoke-void" },
  listEmployees: { channel: "employee:list", kind: "invoke-void" },
  listProducts: { channel: "product:list", kind: "invoke-void" },
  listTasks: { channel: "task:list", kind: "invoke" },
  loadOfficeDesign: { channel: "office:load-design", kind: "invoke-void" },
  loadReport: { channel: "save:load-report", kind: "invoke-void" },
  onActivity: { channel: "activity:event", kind: "event" },
  onAuthEvent: { channel: "auth:event", kind: "event" },
  onStripeStatus: { channel: "stripe:event", kind: "event" },
  openCompanyPath: { channel: "company:open-path", kind: "invoke" },
  openProduct: { channel: "product:open", kind: "invoke" },
  openSaveFolder: { channel: "save:open-folder", kind: "invoke-void" },
  postTeamChat: { channel: "team:post", kind: "invoke" },
  productStatus: { channel: "product:status", kind: "invoke" },
  resetGame: { channel: "app:reset", kind: "invoke-void" },
  resetSpend: { channel: "company:reset-spend", kind: "invoke-void" },
  resolveApproval: { channel: "task:resolve-approval", kind: "invoke" },
  restingRunners: { channel: "runner:resting", kind: "invoke-void" },
  saveOfficeDesign: { channel: "office:save-design", kind: "invoke" },
  setAutopilot: { channel: "company:autopilot", kind: "invoke" },
  setBudget: { channel: "company:budget", kind: "invoke" },
  setMaxAgents: { channel: "company:max-agents", kind: "invoke" },
  startLogin: { channel: "auth:start", kind: "invoke-void" },
  stripeConnect: { channel: "stripe:connect", kind: "invoke-void" },
  stripeDisconnect: { channel: "stripe:disconnect", kind: "invoke-void" },
  stripeStatus: { channel: "stripe:status", kind: "invoke-void" },
  takeDigest: { channel: "company:take-digest", kind: "invoke-void" },
  teamMessages: { channel: "team:messages", kind: "invoke" },
  vercelConnect: { channel: "vercel:connect", kind: "invoke" },
  vercelDisconnect: { channel: "vercel:disconnect", kind: "invoke" },
  vercelListProjects: { channel: "vercel:projects", kind: "invoke" },
} as const;

type Channels = typeof CHANNELS;
export type IpcMethod = keyof Channels;
export type IpcKind<M extends IpcMethod> = Channels[M]["kind"];
export type InvokeMethod = {
  [M in IpcMethod]: IpcKind<M> extends "event" ? never : M;
}[IpcMethod];

/** Structured-clone payloads before main validates them. */
export type WireValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | WireValue[]
  | { [key: string]: WireValue };
