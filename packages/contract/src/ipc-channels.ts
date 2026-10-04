// The window's IPC channels: the calls the page makes of main and the events main broadcasts to it,
// which the page builds its bridge from (apps/desktop/src/renderer/install-bridge.ts) and main
// dispatches and sends by (apps/cli/src/server/lib/ipc-handler.ts and lib/broadcast.ts). Schemas
// and typed contracts live in ipc-registry.ts.

export const CHANNELS = {
  answerQuestion: { channel: "task:answer", kind: "invoke" },
  assignTask: { channel: "task:assign", kind: "invoke" },
  composeCharacter: { channel: "char:compose", kind: "invoke" },
  copyText: { channel: "app:copy-text", kind: "invoke" },
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
  launchAtLogin: { channel: "app:launch-at-login", kind: "invoke-void" },
  listBets: { channel: "bet:list", kind: "invoke-void" },
  listEmployees: { channel: "employee:list", kind: "invoke-void" },
  listProducts: { channel: "product:list", kind: "invoke-void" },
  listTasks: { channel: "task:list", kind: "invoke" },
  loadReport: { channel: "save:load-report", kind: "invoke-void" },
  onActivity: { channel: "activity:event", kind: "event" },
  onAuthEvent: { channel: "auth:event", kind: "event" },
  onStripeStatus: { channel: "stripe:event", kind: "event" },
  openCompanyPath: { channel: "company:open-path", kind: "invoke" },
  openProduct: { channel: "product:open", kind: "invoke" },
  openSaveFolder: { channel: "save:open-folder", kind: "invoke-void" },
  postTeamChat: { channel: "team:post", kind: "invoke" },
  printfulTokenRemove: { channel: "printful:token-remove", kind: "invoke-void" },
  printfulTokenSave: { channel: "printful:token-save", kind: "invoke" },
  printfulTokenStatus: { channel: "printful:token-status", kind: "invoke-void" },
  productStatus: { channel: "product:status", kind: "invoke" },
  resetGame: { channel: "app:reset", kind: "invoke-void" },
  resetSpend: { channel: "company:reset-spend", kind: "invoke-void" },
  resolveAction: { channel: "task:resolve-action", kind: "invoke" },
  resolveApproval: { channel: "task:resolve-approval", kind: "invoke" },
  restingRunners: { channel: "runner:resting", kind: "invoke-void" },
  setAutopilot: { channel: "company:autopilot", kind: "invoke" },
  setBudget: { channel: "company:budget", kind: "invoke" },
  setLaunchAtLogin: { channel: "app:set-launch-at-login", kind: "invoke" },
  setMaxAgents: { channel: "company:max-agents", kind: "invoke" },
  shippingLog: { channel: "task:shipped", kind: "invoke-void" },
  startLogin: { channel: "auth:start", kind: "invoke-void" },
  stripeConnect: { channel: "stripe:connect", kind: "invoke-void" },
  stripeDisconnect: { channel: "stripe:disconnect", kind: "invoke-void" },
  stripeKeyRemove: { channel: "stripe:key-remove", kind: "invoke-void" },
  stripeKeySave: { channel: "stripe:key-save", kind: "invoke" },
  stripeKeyStatus: { channel: "stripe:key-status", kind: "invoke-void" },
  stripeStatus: { channel: "stripe:status", kind: "invoke-void" },
  takeDigest: { channel: "company:take-digest", kind: "invoke-void" },
  teamMessages: { channel: "team:messages", kind: "invoke" },
  vercelConnect: { channel: "vercel:connect", kind: "invoke" },
  vercelDisconnect: { channel: "vercel:disconnect", kind: "invoke" },
  vercelListProjects: { channel: "vercel:projects", kind: "invoke" },
  vercelSaveToken: { channel: "vercel:save-token", kind: "invoke" },
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

export interface IpcFailure {
  ok: false;
  message: string;
}

/**
 * What main answers an invoke with. A refusal crosses the relay as data, the
 * sentence it was worded in, and the page throws that message bare.
 */
export type IpcReply<T> = { ok: true; value: T } | IpcFailure;

/** Whether what came back over the wire is a reply at all: the page checks a reply's shape alone. */
export const isReply = (value: unknown): value is IpcReply<WireValue> =>
  typeof value === "object" &&
  value !== null &&
  "ok" in value &&
  (value.ok === true ||
    (value.ok === false && "message" in value && typeof value.message === "string"));
