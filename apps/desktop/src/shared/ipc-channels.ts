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

  listEmployees: { channel: "employee:list", kind: "invoke" },
  createEmployee: { channel: "employee:create", kind: "invoke" },

  listTasks: { channel: "task:list", kind: "invoke" },
  createTask: { channel: "task:create", kind: "invoke" },
  assignTask: { channel: "task:assign", kind: "invoke" },
  answerQuestion: { channel: "task:answer", kind: "invoke" },
  openCompanyPath: { channel: "company:open-path", kind: "invoke" },
  openProduct: { channel: "company:open-product", kind: "invoke" },

  onActivity: { channel: "activity:event", kind: "event" },
} as const;

export type Channels = typeof CHANNELS;
export type IpcMethod = keyof Channels;
export type IpcKind<M extends IpcMethod> = Channels[M]["kind"];
