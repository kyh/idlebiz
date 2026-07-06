import { Type, type Static } from "@sinclair/typebox";
import { createAuthStorage, hasProviderAuth } from "@repo/pi-driver/auth";
import { resolveModel, resolveModelLoose } from "@repo/pi-driver/model";
import { registryFor } from "@repo/pi-driver/registry";
import { createPiSession } from "@repo/pi-driver/session";
import { parsePiEvent, type PiEvent, type PiUsage } from "@repo/pi-driver/events";
import type {
  AgentSession,
  AuthStorage,
  ToolDefinition,
  Api,
  Model,
} from "@repo/pi-driver/pi-types";
import {
  AUTH_PATH,
  PI_AGENT_DIR,
  companyWorkspace,
  employeeAgentDir,
  employeeSessionDir,
} from "@/main/paths";
import type { Company, Employee } from "@/shared/domain";

import { DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from "@/shared/domain";

interface RunResult {
  ok: boolean;
  error?: string;
  summary: string;
  usage: PiUsage;
  sessionId?: string;
  blockedQuestion?: string;
}

/** Side-effects an autonomous agent can trigger to operate the business with teammates. */
export interface RunHooks {
  messageTeam(text: string): void;
  delegate(role: string, title: string, description: string): void;
  /** Read the latest messages in the team's chat room (live poll during a run). */
  readTeam(): string;
}

interface LiveRun {
  onEvent: (e: PiEvent) => void;
  resolve: (r: RunResult) => void;
  settled: boolean;
  sawOutput: boolean;
  error?: string;
  blockedQuestion?: string;
  usage: PiUsage;
  model: Model<Api>;
  hooks: RunHooks | null;
}

interface EmployeeRuntime {
  session: AgentSession;
  unsub: () => void;
  model: Model<Api>;
  live: LiveRun | null;
}

class PiDriver {
  private auth: AuthStorage | null = null;
  private model: Model<Api> | null = null;
  private employees = new Map<string, EmployeeRuntime>();

  init(): void {
    if (!process.env["PI_CODING_AGENT_DIR"]) process.env["PI_CODING_AGENT_DIR"] = PI_AGENT_DIR;
    this.auth = createAuthStorage(AUTH_PATH);
    this.model = resolveModel(DEFAULT_PROVIDER, DEFAULT_MODEL_ID);
  }

  hasAuth(): boolean {
    return !!this.auth && hasProviderAuth(this.auth, DEFAULT_PROVIDER);
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
        return resolveModelLoose(emp.model.slice(0, slash), emp.model.slice(slash + 1));
      } catch {
        return fallback;
      }
    }
    return fallback;
  }

  private askBossTool(employeeId: string): ToolDefinition {
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
    return tool as unknown as ToolDefinition;
  }

  private messageTeamTool(employeeId: string): ToolDefinition {
    const schema = Type.Object({
      text: Type.String({ description: "A short update for your teammates." }),
    });
    const tool: ToolDefinition<typeof schema> = {
      name: "message_team",
      label: "message the team",
      description:
        "Post a message to your team's shared chat room so teammates can see it live and coordinate — share progress, a decision, an ask, or a handoff. Keep it to one line.",
      parameters: schema,
      execute: async (_id: string, params: Static<typeof schema>) => {
        this.employees.get(employeeId)?.live?.hooks?.messageTeam(params.text);
        return { content: [{ type: "text", text: "Posted to the team room." }], details: {} };
      },
    };
    return tool as unknown as ToolDefinition;
  }

  private readTeamTool(employeeId: string): ToolDefinition {
    const schema = Type.Object({});
    const tool: ToolDefinition<typeof schema> = {
      name: "read_team_chat",
      label: "read the team room",
      description:
        "Read the latest messages in your team's shared chat room. Use this to catch up on what teammates are doing before you act, so you build on their work instead of duplicating it.",
      parameters: schema,
      execute: async (_id: string, _params: Static<typeof schema>) => {
        const text = this.employees.get(employeeId)?.live?.hooks?.readTeam() ?? "";
        return {
          content: [{ type: "text", text: text || "(the team room is empty so far)" }],
          details: {},
        };
      },
    };
    return tool as unknown as ToolDefinition;
  }

  private delegateTool(employeeId: string): ToolDefinition {
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
        "Hand work to a teammate of a given role when they should own it. Call it once to chain a single handoff, or several times to fan work out across the team in parallel. They'll pick it up autonomously and report back in the team room.",
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
    return tool as unknown as ToolDefinition;
  }

  async ensureEmployee(emp: Employee, company: Company): Promise<EmployeeRuntime> {
    const existing = this.employees.get(emp.id);
    if (existing) return existing;
    if (!this.auth) throw new Error("pi driver not initialized");

    // The agent's package dir IS its pi agentDir: the canonical agents/<slug>/AGENTS.md
    // (written by the store at hire time) doubles as the agent's instructions.
    const model = this.modelFor(emp);
    const session = await createPiSession({
      cwd: companyWorkspace(company.id),
      agentDir: employeeAgentDir(company.id, emp.id),
      sessionDir: employeeSessionDir(company.id, emp.id),
      authStorage: this.auth,
      modelRegistry: registryFor(this.auth),
      model,
      thinkingLevel: (emp.thinking as "off" | "low" | "medium" | "high" | undefined) ?? "off",
      customTools: [
        this.askBossTool(emp.id),
        this.messageTeamTool(emp.id),
        this.readTeamTool(emp.id),
        this.delegateTool(emp.id),
      ],
    });

    const rt: EmployeeRuntime = { session, model, live: null, unsub: () => {} };
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
        // Accumulate usage HERE only: turn_end carries the same assistant
        // message, so counting both would double the spend.
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

  private addUsage(live: LiveRun, u: PiUsage): void {
    live.usage.inputTokens += u.inputTokens;
    live.usage.outputTokens += u.outputTokens;
    live.usage.cachedTokens += u.cachedTokens;
    live.usage.costUsd += u.costUsd;
  }

  /** Fallback pricing from the registry's $/MTok rates when pi didn't compute cost. */
  private costFromTokens(model: Model<Api>, usage: PiUsage): number {
    return (
      (usage.inputTokens * model.cost.input +
        usage.outputTokens * model.cost.output +
        usage.cachedTokens * model.cost.cacheRead) /
      1_000_000
    );
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

    if (live.usage.costUsd === 0 && live.usage.inputTokens + live.usage.outputTokens > 0) {
      live.usage.costUsd = this.costFromTokens(live.model, live.usage);
    }

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
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
        model: rt.model,
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
