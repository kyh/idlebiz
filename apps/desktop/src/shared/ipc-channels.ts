// Plain channel metadata — ZERO runtime deps (no zod), so it is safe to import
// from the sandboxed preload (which may only `require("electron")`). This is the
// single runtime source of truth for channel names + kinds. Typed contracts and
// zod payload schemas live in ipc-registry.ts (main/renderer only).

export const CHANNELS = {
  hasAuth: { channel: "agent:hasAuth", kind: "invoke-void" },
  startLogin: { channel: "auth:start", kind: "invoke-void" },
  onAuthEvent: { channel: "auth:event", kind: "event" },
  composeCharacter: { channel: "char:compose", kind: "invoke" },
  getFounderChoices: { channel: "char:founders", kind: "invoke-void" },
  generateHires: { channel: "onboard:hires", kind: "invoke" },
  foundCompany: { channel: "onboard:found", kind: "invoke" },

  getCompany: { channel: "company:get", kind: "invoke-void" },
  loadReport: { channel: "save:load-report", kind: "invoke-void" },
  openSaveFolder: { channel: "save:open-folder", kind: "invoke-void" },
  setAutopilot: { channel: "company:autopilot", kind: "invoke" },
  setBudget: { channel: "company:budget", kind: "invoke" },
  resetSpend: { channel: "company:reset-spend", kind: "invoke" },

  resetGame: { channel: "app:reset", kind: "invoke-void" },

  stripeStatus: { channel: "stripe:status", kind: "invoke-void" },
  stripeConnect: { channel: "stripe:connect", kind: "invoke" },
  stripeDisconnect: { channel: "stripe:disconnect", kind: "invoke" },
  onStripeStatus: { channel: "stripe:event", kind: "event" },

  vercelListProjects: { channel: "vercel:projects", kind: "invoke" },
  vercelConnect: { channel: "vercel:connect", kind: "invoke" },
  vercelDisconnect: { channel: "vercel:disconnect", kind: "invoke" },
  listProducts: { channel: "product:list", kind: "invoke" },
  createProduct: { channel: "product:create", kind: "invoke" },
  productStatus: { channel: "product:status", kind: "invoke" },

  listEmployees: { channel: "employee:list", kind: "invoke" },
  restingRunners: { channel: "runner:resting", kind: "invoke-void" },

  teamMessages: { channel: "team:messages", kind: "invoke" },
  employeeOptions: { channel: "employee:options", kind: "invoke" },
  postTeamChat: { channel: "team:post", kind: "invoke" },
  directEmployee: { channel: "employee:direct", kind: "invoke" },
  setMaxAgents: { channel: "company:max-agents", kind: "invoke" },

  listTasks: { channel: "task:list", kind: "invoke" },
  assignTask: { channel: "task:assign", kind: "invoke" },
  answerQuestion: { channel: "task:answer", kind: "invoke" },
  resolveApproval: { channel: "task:resolve-approval", kind: "invoke" },
  openCompanyPath: { channel: "company:open-path", kind: "invoke" },
  openProduct: { channel: "product:open", kind: "invoke" },

  onActivity: { channel: "activity:event", kind: "event" },

  saveOfficeDesign: { channel: "office:save-design", kind: "invoke" },
  loadOfficeDesign: { channel: "office:load-design", kind: "invoke-void" },
} as const;

type Channels = typeof CHANNELS;
export type IpcMethod = keyof Channels;
export type IpcKind<M extends IpcMethod> = Channels[M]["kind"];

/**
 * The JSON-ish domain the bridge actually sends over structured-clone IPC —
 * the honest type of a payload before main-process validation narrows it.
 */
export type WireValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | WireValue[]
  | { [key: string]: WireValue };
