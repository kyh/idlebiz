import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { listenLoopback } from "@/main/lib/http";
import { BadRequestError, errorMessage } from "@/shared/errors";
import { parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";

// Loopback transport with run-scoped bearer tokens. What the tools are and do
// lives in shared/tool-specs.ts and main/tools.ts; this only carries the call.

/** Answers one call by `METHOD /path` in prose the agent reads; null when there is no such tool. */
export type ToolCaller = (route: string, raw: JsonValue) => string | null;

interface RunHandle {
  /** Run-scoped env for the agent process: the API URL and its bearer token. */
  env: Record<string, string>;
  /** Invalidate the token. Call after the run settles. */
  release: () => void;
}

const MAX_BODY_BYTES = 64 * 1024;

interface ToolResponse {
  ok: boolean;
  error?: string;
  message?: string;
}

const respond = (res: ServerResponse, status: number, payload: ToolResponse): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
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

class ControlPlane {
  private server: Server | null = null;
  private port = 0;
  private runs = new Map<string, ToolCaller>();

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

  registerRun(caller: ToolCaller): RunHandle {
    const token = randomBytes(24).toString("base64url");
    this.runs.set(token, caller);
    return {
      env: { IDLEBIZ_API_URL: this.baseUrl(), IDLEBIZ_RUN_TOKEN: token },
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
      const message = run(route, raw);
      if (message === null) {
        respond(res, 404, { error: `no such tool: ${route}`, ok: false });
      } else {
        respond(res, 200, { message, ok: true });
      }
    } catch (error) {
      if (error instanceof BadRequestError) {
        respond(res, 400, { error: error.message, ok: false });
      } else {
        respond(res, 500, { error: errorMessage(error), ok: false });
      }
    }
  }

  private authenticate(req: IncomingMessage): ToolCaller | null {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    return token ? (this.runs.get(token) ?? null) : null;
  }
}

export const controlPlane = new ControlPlane();
