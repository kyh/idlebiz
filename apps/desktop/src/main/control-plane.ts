import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { listenLoopback } from "@/main/lib/http";
import { INTEGRATION_KINDS, type BlockedAsk } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";
import { parseJson, type JsonValue } from "@/shared/json";

// Loopback transport with run-scoped bearer tokens. Hooks own the game rules.

export interface RunToolHooks {
  messageTeam(text: string): void;
  readTeam(): string;
  /** Returns a human-readable confirmation (or explains why nothing happened). Lands on the named product, else the run's own. */
  delegate(role: string, title: string, description: string, product: string | null): string;
  createProduct(name: string, description: string): string;
  hire(input: { role: string; title: string; name?: string; persona?: string }): string;
  release(slug: string, reason: string): string;
  /** Raise the ask immediately, before the run settles. */
  raiseAsk(ask: BlockedAsk): void;
}

interface RunRecord {
  hooks: RunToolHooks;
  blocked: BlockedAsk | null;
}

/** Keep the first ask; it is the one the founder will answer. */
function raise(record: RunRecord, ask: BlockedAsk): void {
  if (record.blocked) return;
  record.blocked = ask;
  record.hooks.raiseAsk(ask);
}

interface RunHandle {
  /** Run-scoped env for the agent process: the API URL and its bearer token. */
  env: Record<string, string>;
  outcome(): { blocked: BlockedAsk | null };
  /** Record why this run stopped; the first block is the one the founder sees. */
  block(ask: BlockedAsk): void;
  /** Invalidate the token. Call after the run settles. */
  release(): void;
}

const MAX_BODY_BYTES = 64 * 1024;

const AskBossBody = z.object({ question: z.string().min(1) });
const MessageTeamBody = z.object({ text: z.string().min(1) });
const DelegateBody = z.object({
  role: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  product: z.string().min(1).optional(),
});
const HireBody = z.object({
  role: z.string().min(1),
  title: z.string().min(1),
  name: z.string().min(1).optional(),
  persona: z.string().min(1).optional(),
});
const ReleaseBody = z.object({ slug: z.string().min(1), reason: z.string().default("") });
const CreateProductBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(600),
});
const RequestIntegrationBody = z.object({
  kind: z.enum(INTEGRATION_KINDS),
  reason: z.string().min(1),
});

class ControlPlane {
  private server: Server | null = null;
  private port = 0;
  private runs = new Map<string, RunRecord>();

  async start(): Promise<void> {
    if (this.server) return;
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
    if (!this.port) throw new Error("control plane not started");
    return `http://127.0.0.1:${this.port}`;
  }

  registerRun(hooks: RunToolHooks): RunHandle {
    const token = randomBytes(24).toString("base64url");
    const record: RunRecord = { hooks, blocked: null };
    this.runs.set(token, record);
    return {
      env: { IDLEBIZ_API_URL: this.baseUrl(), IDLEBIZ_RUN_TOKEN: token },
      outcome: () => ({ blocked: record.blocked }),
      block: (ask: BlockedAsk) => raise(record, ask),
      release: () => {
        this.runs.delete(token);
      },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const run = this.authenticate(req);
      if (!run) {
        respond(res, 401, { ok: false, error: "unknown or expired run token" });
        return;
      }
      const path = (req.url ?? "").split("?")[0];
      const route = `${req.method ?? "GET"} ${path}`;
      const raw = req.method === "POST" ? await readJsonBody(req) : null;
      // A run may finish while its request body is still arriving.
      if (this.authenticate(req) !== run) {
        respond(res, 401, { ok: false, error: "unknown or expired run token" });
        return;
      }
      switch (route) {
        case "GET /v1/team-chat":
          respond(res, 200, {
            ok: true,
            messages: run.hooks.readTeam() || "(the team room is empty so far)",
          });
          return;
        case "POST /v1/ask-boss": {
          const body = parseBody(raw, AskBossBody);
          raise(run, { type: "question", question: body.question.trim() });
          respond(res, 200, {
            ok: true,
            message:
              "Your question was sent to the founder. Note it and continue with anything you can still do.",
          });
          return;
        }
        case "POST /v1/message-team": {
          const body = parseBody(raw, MessageTeamBody);
          run.hooks.messageTeam(body.text.trim());
          respond(res, 200, { ok: true, message: "Posted to the team room." });
          return;
        }
        case "POST /v1/delegate": {
          const { role, title, description, product } = parseBody(raw, DelegateBody);
          respond(res, 200, {
            ok: true,
            message: run.hooks.delegate(role, title, description, product ?? null),
          });
          return;
        }
        case "POST /v1/create-product": {
          const { name, description } = parseBody(raw, CreateProductBody);
          respond(res, 200, { ok: true, message: run.hooks.createProduct(name, description) });
          return;
        }
        case "POST /v1/hire": {
          const body = parseBody(raw, HireBody);
          respond(res, 200, { ok: true, message: run.hooks.hire(body) });
          return;
        }
        case "POST /v1/release": {
          const body = parseBody(raw, ReleaseBody);
          respond(res, 200, { ok: true, message: run.hooks.release(body.slug, body.reason) });
          return;
        }
        case "POST /v1/request-integration": {
          const body = parseBody(raw, RequestIntegrationBody);
          raise(run, { type: "integration", integration: body.kind, reason: body.reason.trim() });
          respond(res, 200, {
            ok: true,
            message: `The founder has a ${body.kind} connect card waiting. Continue with what you can — this task resumes automatically once connected.`,
          });
          return;
        }
        default:
          respond(res, 404, { ok: false, error: `no such tool: ${route}` });
          return;
      }
    } catch (err) {
      if (err instanceof BadRequest) respond(res, 400, { ok: false, error: err.message });
      else respond(res, 500, { ok: false, error: errorMessage(err) });
    }
  }

  private authenticate(req: IncomingMessage): RunRecord | null {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    return token ? (this.runs.get(token) ?? null) : null;
  }
}

interface ToolResponse {
  ok: boolean;
  error?: string;
  message?: string;
  messages?: string;
}

function respond(res: ServerResponse, status: number, payload: ToolResponse): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

class BadRequest extends Error {}

function parseBody<T>(raw: JsonValue, schema: z.ZodType<T>): T {
  const body = schema.safeParse(raw);
  if (!body.success) throw new BadRequest(z.prettifyError(body.error));
  return body.data;
}

async function readJsonBody(req: IncomingMessage): Promise<JsonValue> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return parseJson(Buffer.concat(chunks).toString("utf8"));
}

export const controlPlane = new ControlPlane();
