import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { listenLoopback } from "@/main/lib/http";
import { INTEGRATION_KINDS, type BlockedAsk } from "@/shared/domain";
import { errorMessage } from "@/shared/errors";
import { parseJson, type JsonValue } from "@/shared/json";

// ---------------------------------------------------------------------------
// The game's control plane: a loopback HTTP API that running CLI agents call
// back into with run-scoped bearer tokens (paperclip convention — agents curl
// the API; the game is the control plane). Each run registers hooks that
// bridge tool calls into game state; the token dies with the run. This file
// is pure transport: bodies are zod-validated at the boundary and every
// game rule lives in the hooks.
// ---------------------------------------------------------------------------

/** Side-effects a running agent can trigger to operate the business. */
export interface RunToolHooks {
  messageTeam(text: string): void;
  /** Latest team-room messages, rendered as a text block. */
  readTeam(): string;
  /** Returns a human-readable confirmation (or explains why nothing happened). */
  delegate(role: string, title: string, description: string): string;
  /** Team-lead only: grow the roster (gated by the company's seat cap). */
  hire(input: { role: string; title: string; name?: string; persona?: string }): string;
  /** Team-lead only: release a teammate (their package is archived, not deleted). */
  release(slug: string, reason: string): string;
  /**
   * The run just asked the founder for something. Fired the moment the ask is
   * made, not when the run settles, so the office can show who is waiting.
   */
  raiseAsk(ask: BlockedAsk): void;
}

interface RunRecord {
  hooks: RunToolHooks;
  blocked: BlockedAsk | null;
}

/**
 * Record why this run stopped and say so. The first ask is the one the task
 * keeps and the founder answers, so it is the only one the office hears about.
 */
function raise(record: RunRecord, ask: BlockedAsk): void {
  if (record.blocked) return;
  record.blocked = ask;
  record.hooks.raiseAsk(ask);
}

interface RunRegistration {
  hooks: RunToolHooks;
}

interface RunHandle {
  /** Run-scoped env for the agent process: the API URL and its bearer token. */
  env: Record<string, string>;
  /** What the agent reported back through the API during the run. */
  outcome(): { blocked: BlockedAsk | null };
  /** Record why this run stopped; the first block is the one the founder sees. */
  block(ask: BlockedAsk): void;
  /** Invalidate the token. Call after the run settles. */
  release(): void;
}

const MAX_BODY_BYTES = 64 * 1024;

// ---- request bodies (validated at the transport boundary) -------------------
const AskBossBody = z.object({ question: z.string().min(1) });
const MessageTeamBody = z.object({ text: z.string().min(1) });
const DelegateBody = z.object({
  role: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
});
const HireBody = z.object({
  role: z.string().min(1),
  title: z.string().min(1),
  name: z.string().min(1).optional(),
  persona: z.string().min(1).optional(),
});
const ReleaseBody = z.object({ slug: z.string().min(1), reason: z.string().default("") });
const RequestIntegrationBody = z.object({
  kind: z.enum(INTEGRATION_KINDS),
  reason: z.string().min(1),
});

class ControlPlane {
  private server: Server | null = null;
  private port = 0;
  private runs = new Map<string, RunRecord>();

  /** Bind the loopback listener (ephemeral port). Idempotent. */
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

  registerRun(reg: RunRegistration): RunHandle {
    const token = randomBytes(24).toString("base64url");
    const record: RunRecord = { hooks: reg.hooks, blocked: null };
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
      switch (route) {
        case "GET /v1/team-chat":
          respond(res, 200, {
            ok: true,
            messages: run.hooks.readTeam() || "(the team room is empty so far)",
          });
          return;
        case "POST /v1/ask-boss": {
          const body = await parseBody(req, AskBossBody);
          raise(run, { type: "question", question: body.question.trim() });
          respond(res, 200, {
            ok: true,
            message:
              "Your question was sent to the founder. Note it and continue with anything you can still do.",
          });
          return;
        }
        case "POST /v1/message-team": {
          const body = await parseBody(req, MessageTeamBody);
          run.hooks.messageTeam(body.text.trim());
          respond(res, 200, { ok: true, message: "Posted to the team room." });
          return;
        }
        case "POST /v1/delegate": {
          const { role, title, description } = await parseBody(req, DelegateBody);
          respond(res, 200, { ok: true, message: run.hooks.delegate(role, title, description) });
          return;
        }
        case "POST /v1/hire": {
          const body = await parseBody(req, HireBody);
          respond(res, 200, { ok: true, message: run.hooks.hire(body) });
          return;
        }
        case "POST /v1/release": {
          const body = await parseBody(req, ReleaseBody);
          respond(res, 200, { ok: true, message: run.hooks.release(body.slug, body.reason) });
          return;
        }
        case "POST /v1/request-integration": {
          const body = await parseBody(req, RequestIntegrationBody);
          // A typed ask: the notification renders a [Connect] button and this
          // task auto-resumes when the founder connects.
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

/** Every tool route answers with this envelope. */
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

/** The agent sent a body the tool cannot read; it gets the schema's complaint back. */
class BadRequest extends Error {}

/** The body as the route's schema sees it, or a BadRequest naming what was wrong. */
async function parseBody<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const body = schema.safeParse(await readJsonBody(req));
  if (!body.success) throw new BadRequest(z.prettifyError(body.error));
  return body.data;
}

/** Collect and parse the body; zod narrows the shape per route. */
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
