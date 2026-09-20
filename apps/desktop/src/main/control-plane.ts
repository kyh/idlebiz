import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { listenLoopback } from "@/main/lib/http";
import { BET_METRICS, LandingPathSchema } from "@/shared/bets";
import type { BetMetric } from "@/shared/bets";
import { INTEGRATION_KINDS } from "@/shared/domain";
import type { BlockedAsk } from "@/shared/domain";
import { BadRequestError, errorMessage } from "@/shared/errors";
import { parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";

// Loopback transport with run-scoped bearer tokens. Hooks own the game rules.

export interface RunToolHooks {
  messageTeam: (text: string) => void;
  readTeam: () => string;
  /** Returns a human-readable confirmation (or explains why nothing happened). Lands on the named bet's product, else the named product, else the run's own. */
  delegate: (input: {
    role: string;
    title: string;
    description: string;
    product: string | null;
    bet: string | null;
  }) => string;
  createProduct: (name: string, description: string) => string;
  killProduct: (slug: string, reason: string) => string;
  /** The ledger as the team reads it: every live bet and the latest verdicts. */
  readBets: () => string;
  openBet: (input: OpenBetInput) => string;
  measureBet: (slug: string) => string;
  killBet: (slug: string, reason: string) => string;
  hire: (input: { role: string; title: string; name?: string; persona?: string }) => string;
  release: (slug: string, reason: string) => string;
  /** Raise the ask immediately, before the run settles. */
  raiseAsk: (ask: BlockedAsk) => void;
}

export interface OpenBetInput {
  product: string | null;
  title: string;
  hypothesis: string;
  metric: BetMetric;
  /** Where a users bet's links land; null takes a path of its own. */
  landingPath: string | null;
  target: number;
  budgetUsd: number;
  windowHours: number;
}

interface RunRecord {
  hooks: RunToolHooks;
  blocked: BlockedAsk | null;
}

/** Keep the first ask; it is the one the founder will answer. */
const raise = (record: RunRecord, ask: BlockedAsk): void => {
  if (record.blocked) {
    return;
  }
  record.blocked = ask;
  record.hooks.raiseAsk(ask);
};

interface RunHandle {
  /** Run-scoped env for the agent process: the API URL and its bearer token. */
  env: Record<string, string>;
  outcome: () => { blocked: BlockedAsk | null };
  /** Record why this run stopped; the first block is the one the founder sees. */
  block: (ask: BlockedAsk) => void;
  /** Invalidate the token. Call after the run settles. */
  release: () => void;
}

const MAX_BODY_BYTES = 64 * 1024;

const AskBossBody = z.object({ question: z.string().min(1) });
const MessageTeamBody = z.object({ text: z.string().min(1) });
const DelegateBody = z.object({
  bet: z.string().min(1).optional(),
  description: z.string().min(1),
  product: z.string().min(1).optional(),
  role: z.string().min(1),
  title: z.string().min(1),
});
const HireBody = z.object({
  name: z.string().min(1).optional(),
  persona: z.string().min(1).optional(),
  role: z.string().min(1),
  title: z.string().min(1),
});
const ReleaseBody = z.object({ reason: z.string().default(""), slug: z.string().min(1) });
const CreateProductBody = z.object({
  description: z.string().trim().min(1).max(600),
  name: z.string().trim().min(1).max(80),
});
const SlugReasonBody = z.object({ reason: z.string().trim().min(1), slug: z.string().min(1) });
const OpenBetBody = z.object({
  budgetUsd: z.number().positive().max(1000),
  hypothesis: z.string().trim().min(1).max(600),
  landingPath: LandingPathSchema.optional(),
  metric: z.enum(BET_METRICS),
  product: z.string().min(1).optional(),
  target: z.number().positive(),
  title: z.string().trim().min(1).max(80),
  // long enough for a number to answer, short enough that a dud dies within the fortnight
  windowHours: z.number().min(1).max(336),
});
const MeasureBetBody = z.object({ slug: z.string().min(1) });
const RequestIntegrationBody = z.object({
  kind: z.enum(INTEGRATION_KINDS),
  reason: z.string().min(1),
});

interface ToolResponse {
  ok: boolean;
  error?: string;
  message?: string;
  messages?: string;
}

const respond = (res: ServerResponse, status: number, payload: ToolResponse): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
};

const parseBody = <T>(raw: JsonValue, schema: z.ZodType<T>): T => {
  const body = schema.safeParse(raw);
  if (!body.success) {
    throw new BadRequestError(z.prettifyError(body.error));
  }
  return body.data;
};

const readJsonBody = async (req: IncomingMessage): Promise<JsonValue> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) {
    return {};
  }
  return parseJson(Buffer.concat(chunks).toString("utf-8"));
};

type Tool = (run: RunRecord, raw: JsonValue) => Omit<ToolResponse, "ok">;

/** Every company tool, by `METHOD /path`. Each parses its own body and answers in prose the agent reads. */
const TOOLS = {
  "GET /v1/bets": (run) => ({ message: run.hooks.readBets() }),
  "GET /v1/team-chat": (run) => ({
    messages: run.hooks.readTeam() || "(the team room is empty so far)",
  }),
  "POST /v1/ask-boss": (run, raw) => {
    const body = parseBody(raw, AskBossBody);
    raise(run, { question: body.question.trim(), type: "question" });
    return {
      message:
        "Your question was sent to the founder. Note it and continue with anything you can still do.",
    };
  },
  "POST /v1/create-product": (run, raw) => {
    const { name, description } = parseBody(raw, CreateProductBody);
    return { message: run.hooks.createProduct(name, description) };
  },
  "POST /v1/delegate": (run, raw) => {
    const body = parseBody(raw, DelegateBody);
    return {
      message: run.hooks.delegate({
        ...body,
        bet: body.bet ?? null,
        product: body.product ?? null,
      }),
    };
  },
  "POST /v1/hire": (run, raw) => ({ message: run.hooks.hire(parseBody(raw, HireBody)) }),
  "POST /v1/kill-bet": (run, raw) => {
    const { slug, reason } = parseBody(raw, SlugReasonBody);
    return { message: run.hooks.killBet(slug, reason) };
  },
  "POST /v1/kill-product": (run, raw) => {
    const { slug, reason } = parseBody(raw, SlugReasonBody);
    return { message: run.hooks.killProduct(slug, reason) };
  },
  "POST /v1/measure-bet": (run, raw) => ({
    message: run.hooks.measureBet(parseBody(raw, MeasureBetBody).slug),
  }),
  "POST /v1/message-team": (run, raw) => {
    run.hooks.messageTeam(parseBody(raw, MessageTeamBody).text.trim());
    return { message: "Posted to the team room." };
  },
  "POST /v1/open-bet": (run, raw) => {
    const body = parseBody(raw, OpenBetBody);
    return {
      message: run.hooks.openBet({
        ...body,
        landingPath: body.landingPath ?? null,
        product: body.product ?? null,
      }),
    };
  },
  "POST /v1/release": (run, raw) => {
    const body = parseBody(raw, ReleaseBody);
    return { message: run.hooks.release(body.slug, body.reason) };
  },
  "POST /v1/request-integration": (run, raw) => {
    const body = parseBody(raw, RequestIntegrationBody);
    raise(run, { integration: body.kind, reason: body.reason.trim(), type: "integration" });
    return {
      message: `The founder has a ${body.kind} connect card waiting. Continue with what you can — this task resumes automatically once connected.`,
    };
  },
} satisfies Record<string, Tool>;

const isTool = (route: string): route is keyof typeof TOOLS => Object.hasOwn(TOOLS, route);

class ControlPlane {
  private server: Server | null = null;
  private port = 0;
  private runs = new Map<string, RunRecord>();

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    this.port = await listenLoopback(server);
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.runs.clear();
  }

  baseUrl(): string {
    if (!this.port) {
      throw new Error("control plane not started");
    }
    return `http://127.0.0.1:${this.port}`;
  }

  registerRun(hooks: RunToolHooks): RunHandle {
    const token = randomBytes(24).toString("base64url");
    const record: RunRecord = { blocked: null, hooks };
    this.runs.set(token, record);
    return {
      block: (ask: BlockedAsk) => raise(record, ask),
      env: { IDLEBIZ_API_URL: this.baseUrl(), IDLEBIZ_RUN_TOKEN: token },
      outcome: () => ({ blocked: record.blocked }),
      release: () => {
        this.runs.delete(token);
      },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const run = this.authenticate(req);
      if (!run) {
        respond(res, 401, { error: "unknown or expired run token", ok: false });
        return;
      }
      const [path] = (req.url ?? "").split("?");
      const route = `${req.method ?? "GET"} ${path}`;
      const raw = req.method === "POST" ? await readJsonBody(req) : {};
      // A run may finish while its request body is still arriving.
      if (this.authenticate(req) !== run) {
        respond(res, 401, { error: "unknown or expired run token", ok: false });
        return;
      }
      if (isTool(route)) {
        const tool: Tool = TOOLS[route];
        respond(res, 200, { ok: true, ...tool(run, raw) });
      } else {
        respond(res, 404, { error: `no such tool: ${route}`, ok: false });
      }
    } catch (error) {
      if (error instanceof BadRequestError) {
        respond(res, 400, { error: error.message, ok: false });
      } else {
        respond(res, 500, { error: errorMessage(error), ok: false });
      }
    }
  }

  private authenticate(req: IncomingMessage): RunRecord | null {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    return token ? (this.runs.get(token) ?? null) : null;
  }
}

export const controlPlane = new ControlPlane();
