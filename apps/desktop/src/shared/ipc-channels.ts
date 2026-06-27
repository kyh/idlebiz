// Plain channel metadata — ZERO runtime deps (no zod), so it is safe to import
// from the sandboxed preload (which may only `require("electron")`). This is the
// single runtime source of truth for channel names + kinds. Typed contracts and
// zod payload schemas live in ipc-registry.ts (main/renderer only).

export const CHANNELS = {
  hasAuth: { channel: "agent:hasAuth", kind: "invoke-void" },
  startLogin: { channel: "auth:start", kind: "invoke-void" },
  submitAuthCode: { channel: "auth:code", kind: "invoke" },
  onAuthEvent: { channel: "auth:event", kind: "event" },
  composeCharacter: { channel: "char:compose", kind: "invoke" },
  getFounderChoices: { channel: "char:founders", kind: "invoke-void" },
  generateHires: { channel: "onboard:hires", kind: "invoke" },
  batchHire: { channel: "onboard:batchHire", kind: "invoke" },
  completeOnboarding: { channel: "onboard:complete", kind: "invoke" },

  getCompany: { channel: "company:get", kind: "invoke-void" },
  createCompany: { channel: "company:create", kind: "invoke" },
  setAutopilot: { channel: "company:autopilot", kind: "invoke" },
  setBudget: { channel: "company:budget", kind: "invoke" },
  resetSpend: { channel: "company:reset-spend", kind: "invoke" },

  resetGame: { channel: "app:reset", kind: "invoke-void" },

  stripeStatus: { channel: "stripe:status", kind: "invoke-void" },
  stripeConnect: { channel: "stripe:connect", kind: "invoke" },
  stripeDisconnect: { channel: "stripe:disconnect", kind: "invoke" },
  onStripeStatus: { channel: "stripe:event", kind: "event" },

  listEmployees: { channel: "employee:list", kind: "invoke" },
  createEmployee: { channel: "employee:create", kind: "invoke" },

  listTeams: { channel: "team:list", kind: "invoke" },
  teamMessages: { channel: "team:messages", kind: "invoke" },

  listTasks: { channel: "task:list", kind: "invoke" },
  createTask: { channel: "task:create", kind: "invoke" },
  assignTask: { channel: "task:assign", kind: "invoke" },
  answerQuestion: { channel: "task:answer", kind: "invoke" },
  openCompanyPath: { channel: "company:open-path", kind: "invoke" },
  openProduct: { channel: "company:open-product", kind: "invoke" },

  onActivity: { channel: "activity:event", kind: "event" },

  saveOfficeDesign: { channel: "office:save-design", kind: "invoke" },
  loadOfficeDesign: { channel: "office:load-design", kind: "invoke-void" },
} as const;

export type Channels = typeof CHANNELS;
export type IpcMethod = keyof Channels;
export type IpcKind<M extends IpcMethod> = Channels[M]["kind"];
