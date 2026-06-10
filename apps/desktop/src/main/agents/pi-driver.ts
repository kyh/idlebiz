import { mkdirSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  AuthStorage,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { getModels } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import {
  AUTH_PATH,
  PI_AGENT_DIR,
  companyWorkspace,
  employeeAgentDir,
  employeeSessionDir,
} from "@/main/paths";
import { parsePiEvent, type PiEvent } from "@/main/agents/event-parser";
import type { Company, Employee } from "@/shared/domain";

import { DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from "@/shared/domain";

export interface RunResult {
  ok: boolean;
  error?: string;
  summary: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  sessionId?: string;
  blockedQuestion?: string;
}

/** Side-effects an autonomous agent can trigger to operate the business with teammates. */
export interface RunHooks {
  messageTeam(text: string): void;
  delegate(role: string, title: string, description: string): void;
}

interface LiveRun {
  onEvent: (e: PiEvent) => void;
  resolve: (r: RunResult) => void;
  settled: boolean;
  sawOutput: boolean;
  error?: string;
  blockedQuestion?: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
  hooks: RunHooks | null;
}

interface EmployeeRuntime {
  session: AgentSession;
  unsub: () => void;
  live: LiveRun | null;
}

// getModels types its arg as a provider union; we hold runtime strings (validated
// by the lookup below), so narrow at this single boundary.
type KnownProvider = Parameters<typeof getModels>[0];
function resolveModel(provider: string, id: string): Model<Api> {
  const m = getModels(provider as KnownProvider).find((x) => x.id === id);
  if (!m) throw new Error(`Model "${provider}/${id}" not found`);
  return m;
}

class PiDriver {
  private auth: AuthStorage | null = null;
  private registry: ModelRegistry | null = null;
  private model: Model<Api> | null = null;
  private employees = new Map<string, EmployeeRuntime>();

  init(): void {
    if (!process.env["PI_CODING_AGENT_DIR"]) process.env["PI_CODING_AGENT_DIR"] = PI_AGENT_DIR;
    this.auth = AuthStorage.create(AUTH_PATH);
    this.registry = ModelRegistry.create(this.auth);
    this.model = resolveModel(DEFAULT_PROVIDER, DEFAULT_MODEL_ID);
  }

  hasAuth(): boolean {
    return !!this.auth && this.auth.hasAuth(DEFAULT_PROVIDER);
  }

  /** The shared AuthStorage (login flows, one-off completions). */
  getAuth(): AuthStorage {
    if (!this.auth) throw new Error("pi driver not initialized");
    return this.auth;
  }

  private modelFor(emp: Employee): Model<Api> {
    const fallback = this.model;
    if (!fallback) throw new Error("pi driver not initialized");
    const slash = emp.model.indexOf("/");
    if (slash > 0) {
      try {
        return resolveModel(emp.model.slice(0, slash), emp.model.slice(slash + 1));
      } catch {
        return fallback;
      }
    }
    return fallback;
  }

  private askBossTool(employeeId: string): ToolDefinition<ReturnType<typeof Type.Object>> {
    const schema = Type.Object({
      question: Type.String({ description: "A concise question for the founder." }),
    });
    const tool: ToolDefinition<typeof schema> = {
      name: "ask_boss",
      label: "ask the boss",
      description:
        "Ask the founder a question when you are genuinely blocked or need a decision only they can make. Use sparingly; prefer making reasonable choices yourself.",
      parameters: schema,
      execute: async (_id: string, params: Static<typeof schema>) => {
        const rt = this.employees.get(employeeId);
        if (rt?.live) rt.live.blockedQuestion = params.question;
        return {
          content: [
            {
              type: "text",
              text: "Your question was sent to the founder. Note it and continue with anything you can still do.",
            },
          ],
          details: {},
        };
      },
    };
    // schema generic is invariant in the lib's type; the runtime shape is correct.
    return tool as unknown as ToolDefinition<ReturnType<typeof Type.Object>>;
  }

  private messageTeamTool(employeeId: string): ToolDefinition<ReturnType<typeof Type.Object>> {
    const schema = Type.Object({
      text: Type.String({ description: "A short update for your teammates." }),
    });
    const tool: ToolDefinition<typeof schema> = {
      name: "message_team",
      label: "message the team",
      description:
        "Post a short update to the company team channel so teammates can coordinate — share progress, a decision, or an ask. Keep it to one line.",
      parameters: schema,
      execute: async (_id: string, params: Static<typeof schema>) => {
        this.employees.get(employeeId)?.live?.hooks?.messageTeam(params.text);
        return { content: [{ type: "text", text: "Posted to the team channel." }], details: {} };
      },
    };
    return tool as unknown as ToolDefinition<ReturnType<typeof Type.Object>>;
  }

  private delegateTool(employeeId: string): ToolDefinition<ReturnType<typeof Type.Object>> {
    const schema = Type.Object({
      role: Type.String({
        description:
          "Teammate role to hand this to (e.g. engineer, designer, pm, qa, researcher, writer, analyst, editor).",
      }),
      title: Type.String({ description: "Short task title." }),
      description: Type.String({ description: "Concretely what they should do." }),
    });
    const tool: ToolDefinition<typeof schema> = {
      name: "delegate",
      label: "delegate to a teammate",
      description:
        "Create a task for a teammate of a given role when the work is better owned by them. They'll pick it up autonomously.",
      parameters: schema,
      execute: async (_id: string, params: Static<typeof schema>) => {
        this.employees
          .get(employeeId)
          ?.live?.hooks?.delegate(params.role, params.title, params.description);
        return {
          content: [{ type: "text", text: `Delegated "${params.title}" to a ${params.role}.` }],
          details: {},
        };
      },
    };
    return tool as unknown as ToolDefinition<ReturnType<typeof Type.Object>>;
  }

  async ensureEmployee(emp: Employee, company: Company): Promise<EmployeeRuntime> {
    const existing = this.employees.get(emp.id);
    if (existing) return existing;
    if (!this.auth || !this.registry) throw new Error("pi driver not initialized");

    // The agent's package dir IS its pi agentDir: the canonical agents/<slug>/AGENTS.md
    // (written by the store at hire time) doubles as the agent's instructions.
    const cwd = companyWorkspace(company.id);
    const agentDir = employeeAgentDir(company.id, emp.id);
    const sessionDir = employeeSessionDir(company.id, emp.id);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [] });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage: this.auth,
      modelRegistry: this.registry,
      resourceLoader,
      model: this.modelFor(emp),
      thinkingLevel: (emp.thinking as "off" | "low" | "medium" | "high" | undefined) ?? "off",
      sessionManager: SessionManager.continueRecent(cwd, sessionDir),
      settingsManager: SettingsManager.create(cwd, agentDir),
      customTools: [
        this.askBossTool(emp.id),
        this.messageTeamTool(emp.id),
        this.delegateTool(emp.id),
      ],
    });

    const rt: EmployeeRuntime = { session, live: null, unsub: () => {} };
    rt.unsub = session.subscribe((raw: unknown) => this.handleEvent(emp.id, raw));
    this.employees.set(emp.id, rt);
    return rt;
  }

  private handleEvent(employeeId: string, raw: unknown): void {
    const rt = this.employees.get(employeeId);
    if (!rt || !rt.live) return;
    const live = rt.live;
    const ev = parsePiEvent(raw);
    if (!ev) return;

    try {
      live.onEvent(ev);
    } catch {
      /* never let a listener throw break the agent */
    }

    switch (ev.type) {
      case "message_update":
        if (ev.delta) live.sawOutput = true;
        break;
      case "message_end":
        if (ev.text) live.sawOutput = true;
        if (ev.stopReason === "error" || ev.errorMessage)
          live.error = ev.errorMessage ?? "agent error";
        if (ev.usage) this.addUsage(live, ev.usage);
        break;
      case "turn_end":
        if (ev.usage) this.addUsage(live, ev.usage);
        break;
      case "tool_start":
        live.sawOutput = true;
        break;
      case "agent_end":
        this.settle(employeeId);
        break;
      default:
        break;
    }
  }

  private addUsage(
    live: LiveRun,
    u: { inputTokens: number; outputTokens: number; cachedTokens: number },
  ): void {
    live.usage.inputTokens += u.inputTokens;
    live.usage.outputTokens += u.outputTokens;
    live.usage.cachedTokens += u.cachedTokens;
  }

  private settle(employeeId: string, extra?: { error?: string }): void {
    const rt = this.employees.get(employeeId);
    if (!rt || !rt.live || rt.live.settled) return;
    const live = rt.live;
    live.settled = true;

    let summary = "";
    try {
      summary = rt.session.getLastAssistantText() ?? "";
    } catch {
      summary = "";
    }
    let error = extra?.error ?? live.error;
    if (!error && !live.sawOutput) error = "No output produced (likely an auth or model failure).";

    rt.live = null;
    live.resolve({
      ok: !error,
      error,
      summary,
      usage: live.usage,
      sessionId: rt.session.sessionFile ?? undefined,
      blockedQuestion: live.blockedQuestion,
    });
  }

  async runTask(
    emp: Employee,
    company: Company,
    task: { title: string; description: string | null },
    onEvent: (e: PiEvent) => void,
    hooks?: RunHooks,
  ): Promise<RunResult> {
    const rt = await this.ensureEmployee(emp, company);
    if (rt.live) throw new Error(`employee ${emp.id} already running a task`);

    return await new Promise<RunResult>((resolve) => {
      rt.live = {
        onEvent,
        resolve,
        settled: false,
        sawOutput: false,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        hooks: hooks ?? null,
      };
      const prompt = `${task.title}\n\n${task.description ?? ""}`.trim();
      Promise.resolve(rt.session.prompt(prompt)).catch((err: unknown) => {
        this.settle(emp.id, { error: err instanceof Error ? err.message : String(err) });
      });
    });
  }

  async disposeEmployee(employeeId: string): Promise<void> {
    const rt = this.employees.get(employeeId);
    if (!rt) return;
    this.employees.delete(employeeId);
    try {
      rt.unsub();
      await rt.session.abort();
      rt.session.dispose();
    } catch {
      /* best-effort teardown */
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.employees.keys()].map((id) => this.disposeEmployee(id)));
  }
}

export const piDriver = new PiDriver();
