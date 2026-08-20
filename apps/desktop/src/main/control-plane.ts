import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { approvalKey, classifyCommand } from "@/shared/domain";
import type { BlockedAsk } from "@/shared/domain";
import type { JsonValue } from "@/shared/json";
import { PERMISSION_HOOK_PATH } from "@/main/paths";
import { PERMISSION_HOOK_SOURCE } from "@/main/permission-hook-source";

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
}

interface RunRecord {
  hooks: RunToolHooks;
  blocked: BlockedAsk | null;
  companyId: string;
}

export interface RunRegistration {
  employeeId: string;
  companyId: string;
  taskId?: string;
  hooks: RunToolHooks;
}

export interface RunHandle {
  /** Run-scoped env for the agent process (API URL + bearer token + ids). */
  env: Record<string, string>;
  /** The PreToolUse hook command for this run, with its API url + token baked in. */
  permissionHookCommand: string;
  /** What the agent reported back through the API during the run. */
  outcome(): { blocked: BlockedAsk | null };
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
  kind: z.enum(["vercel", "stripe"]),
  reason: z.string().min(1),
});
const PermissionBody = z.object({ command: z.string().min(1) });

class ControlPlane {
  private server: Server | null = null;
  private port = 0;
  private runs = new Map<string, RunRecord>();
  /** companyId → action keys the founder has signed off, for this app session. */
  private approvals = new Map<string, Set<string>>();

  /** Bind the loopback listener (ephemeral port). Idempotent. */
  async start(): Promise<void> {
    if (this.server) return;
    mkdirSync(dirname(PERMISSION_HOOK_PATH), { recursive: true });
    writeFileSync(PERMISSION_HOOK_PATH, PERMISSION_HOOK_SOURCE, "utf8");
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        // address() is AddressInfo | string | null; only the object form has a port
        const addr = z.object({ port: z.number() }).safeParse(server.address());
        if (addr.success) this.port = addr.data.port;
        resolve();
      });
    });
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
    const record: RunRecord = { hooks: reg.hooks, blocked: null, companyId: reg.companyId };
    this.runs.set(token, record);
    const base = {
      IDLEBIZ_API_URL: this.baseUrl(),
      IDLEBIZ_RUN_TOKEN: token,
      IDLEBIZ_AGENT_ID: reg.employeeId,
      IDLEBIZ_COMPANY_ID: reg.companyId,
    };
    return {
      env: reg.taskId ? { ...base, IDLEBIZ_TASK_ID: reg.taskId } : base,
      // argv, not env: codex does not give hook processes the parent env
      permissionHookCommand: `node ${quoteArg(PERMISSION_HOOK_PATH)} ${quoteArg(this.baseUrl())} ${quoteArg(token)}`,
      outcome: () => ({ blocked: record.blocked }),
      release: () => {
        this.runs.delete(token);
      },
    };
  }

  /** The founder signed off on one action; the agent's retry now passes. */
  approveCommand(companyId: string, command: string): void {
    const set = this.approvals.get(companyId) ?? new Set<string>();
    set.add(approvalKey(command));
    this.approvals.set(companyId, set);
  }

  private isApproved(companyId: string, command: string): boolean {
    return this.approvals.get(companyId)?.has(approvalKey(command)) ?? false;
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
        case "GET /v1/team-chat": {
          respond(res, 200, {
            ok: true,
            messages: run.hooks.readTeam() || "(the team room is empty so far)",
          });
          return;
        }
        case "POST /v1/ask-boss": {
          const body = AskBossBody.safeParse(await readJsonBody(req));
          if (!body.success) {
            respond(res, 400, { ok: false, error: body.error.message });
            return;
          }
          run.blocked = { type: "question", question: body.data.question.trim() };
          respond(res, 200, {
            ok: true,
            message:
              "Your question was sent to the founder. Note it and continue with anything you can still do.",
          });
          return;
        }
        case "POST /v1/message-team": {
          const body = MessageTeamBody.safeParse(await readJsonBody(req));
          if (!body.success) {
            respond(res, 400, { ok: false, error: body.error.message });
            return;
          }
          run.hooks.messageTeam(body.data.text.trim());
          respond(res, 200, { ok: true, message: "Posted to the team room." });
          return;
        }
        case "POST /v1/delegate": {
          const body = DelegateBody.safeParse(await readJsonBody(req));
          if (!body.success) {
            respond(res, 400, { ok: false, error: body.error.message });
            return;
          }
          const { role, title, description } = body.data;
          respond(res, 200, { ok: true, message: run.hooks.delegate(role, title, description) });
          return;
        }
        case "POST /v1/hire": {
          const body = HireBody.safeParse(await readJsonBody(req));
          if (!body.success) {
            respond(res, 400, { ok: false, error: body.error.message });
            return;
          }
          respond(res, 200, { ok: true, message: run.hooks.hire(body.data) });
          return;
        }
        case "POST /v1/release": {
          const body = ReleaseBody.safeParse(await readJsonBody(req));
          if (!body.success) {
            respond(res, 400, { ok: false, error: body.error.message });
            return;
          }
          respond(res, 200, {
            ok: true,
            message: run.hooks.release(body.data.slug, body.data.reason),
          });
          return;
        }
        case "POST /v1/request-integration": {
          const body = RequestIntegrationBody.safeParse(await readJsonBody(req));
          if (!body.success) {
            respond(res, 400, { ok: false, error: body.error.message });
            return;
          }
          // A typed ask: the notification renders a [Connect] button and this
          // task auto-resumes when the founder connects.
          run.blocked = {
            type: "integration",
            integration: body.data.kind,
            reason: body.data.reason.trim(),
          };
          respond(res, 200, {
            ok: true,
            message: `The founder has a ${body.data.kind} connect card waiting. Continue with what you can — this task resumes automatically once connected.`,
          });
          return;
        }
        case "POST /v1/permission": {
          const body = PermissionBody.safeParse(await readJsonBody(req));
          if (!body.success) {
            respond(res, 400, { ok: false, error: body.error.message });
            return;
          }
          const { command } = body.data;
          // Work that stays inside the workspace is the employee's own
          // business; only what reaches past it goes to the founder.
          const verdict = classifyCommand(command);
          if (verdict.decision === "allow" || this.isApproved(run.companyId, command)) {
            respond(res, 200, { ok: true, decision: "allow" });
            return;
          }
          // First block wins. A held command is usually followed by the agent
          // narrating the block, and whatever it does next must not replace
          // the ask the founder actually needs to decide.
          run.blocked ??= { type: "approval", command };
          respond(res, 200, {
            ok: true,
            decision: "deny",
            reason: `${verdict.rule.describe} That needs the founder's sign-off, so they now have an approval card — this task resumes automatically once they decide. Continue with anything that doesn't depend on it.`,
          });
          return;
        }
        default: {
          respond(res, 404, { ok: false, error: `no such tool: ${route}` });
          return;
        }
      }
    } catch (err) {
      respond(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
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
  decision?: "allow" | "deny";
  reason?: string;
}

/** Single-quote for the shell the CLIs run hook commands through. */
function quoteArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function respond(res: ServerResponse, status: number, payload: ToolResponse): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
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
  // JSON.parse is typed `any`; its actual return domain is exactly JsonValue.
  const parsed: JsonValue = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed;
}

export const controlPlane = new ControlPlane();
