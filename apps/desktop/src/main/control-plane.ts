import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ROOT_DIR } from "@/main/paths";
import { BadRequestError, errorMessage } from "@/shared/errors";
import { parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";
import { RefusalError } from "@/shared/refusal";

// Each run's own line back to the company: an HTTP server on a unix socket only that run's seal
// lets it connect to (`apiSocket` in main/agents/seal.ts). What the tools are and do lives in
// shared/tool-specs.ts and main/tools.ts; this only carries the call.
//
// The socket, not the bearer, is what says which run is calling. Runs are processes of the
// founder's own user, so one run can read another's env (`ps -E`, or sysctl's KERN_PROCARGS2,
// which needs no setuid program), token and all: a token alone would let a teammate call as the
// lead. The socket sits in a folder no run writes, and each run's seal allows it to connect to its
// own socket alone, so a token read from another run's env is no use without that run's socket.
// The token stays as a second check, and a server takes only the token of its own run.

/** Answers one call by `METHOD /path` in prose the agent reads; null when there is no such tool. */
export type ToolCaller = (route: string, raw: JsonValue) => Promise<string | null>;

interface RunHandle {
  /** Run-scoped env for the agent process: the socket its API answers on and its bearer token. */
  env: { IDLEBIZ_API_SOCKET: string; IDLEBIZ_RUN_TOKEN: string };
  /** The socket's path, which the run's seal lets it connect to and no other run's. */
  socket: string;
  /** Close the socket and invalidate the token. Call after the run settles. */
  release: () => void;
}

/** The longest path macOS takes for a unix socket: `sun_path` holds 104 bytes, its NUL included. */
export const SOCKET_PATH_MAX_BYTES = 103;

const MAX_BODY_BYTES = 64 * 1024;

const fits = (socket: string): boolean => Buffer.byteLength(socket) <= SOCKET_PATH_MAX_BYTES;

interface SocketDirs {
  inSave: string;
  aside: string;
}

/**
 * Where runs' sockets go for the save at `root`: in the save, hidden so it is never read as a
 * company, and, for a save whose path is too long for that, a folder in HOME named for the save.
 * A run writes neither: the save but for its own folders, and HOME but for its runner's state.
 */
export const socketDirs = (root: string, home: string): SocketDirs => ({
  aside: path.join(
    home,
    ".idlebiz-run",
    createHash("sha256").update(root).digest("hex").slice(0, 8),
  ),
  inSave: path.join(root, ".run"),
});

/** The path of the socket `id` for the save at `root`: the first of `socketDirs` short enough for it. */
export const runSocketPath = (root: string, home: string, id: string): string => {
  const { inSave, aside } = socketDirs(root, home);
  const candidates = [path.join(inSave, id), path.join(aside, id)];
  const socket = candidates.find(fits);
  if (socket === undefined) {
    throw new RefusalError(
      `IdleBiz could not open a run's line to the company: a socket at ${candidates.join(" or ")} would be longer than the ${SOCKET_PATH_MAX_BYTES} bytes macOS allows its path, so no run starts. Move the save (IDLEBIZ_ROOT_DIR) or your home to a shorter path.`,
    );
  }
  return socket;
};

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

/** A registered run: its tools while it lives, and the token only its socket takes. */
interface Run {
  token: Buffer;
  caller: ToolCaller | null;
}

const presented = (req: IncomingMessage): Buffer => {
  const header = req.headers.authorization ?? "";
  return Buffer.from(header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "");
};

/** The run's tools when `req` carries its token and the run has not settled; null otherwise. */
const authenticate = (run: Run, req: IncomingMessage): ToolCaller | null => {
  const token = presented(req);
  const matches = token.length === run.token.length && timingSafeEqual(token, run.token);
  return matches ? run.caller : null;
};

const listen = async (server: Server, socket: string): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
};

/** Answers one call on `run`'s socket: its tools, while it lives and the call carries its token. */
const handle = async (run: Run, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  try {
    const caller = authenticate(run, req);
    if (!caller) {
      respond(res, 401, { error: "unknown or expired run token", ok: false });
      return;
    }
    const [routePath] = (req.url ?? "").split("?");
    const route = `${req.method ?? "GET"} ${routePath}`;
    const raw = req.method === "POST" ? await readJsonBody(req) : {};
    // A run may finish while its request body is still arriving.
    if (authenticate(run, req) !== caller) {
      respond(res, 401, { error: "unknown or expired run token", ok: false });
      return;
    }
    const message = await caller(route, raw);
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
};

export class ControlPlane {
  private started = false;
  private readonly root: string;
  private readonly home: string;
  /** Every live run's server, by its socket. */
  private readonly servers = new Map<string, Server>();

  constructor(root: string = ROOT_DIR, home: string = homedir()) {
    this.root = root;
    this.home = home;
  }

  /** Sweeps the sockets a run cut off by a crash or a quit left behind, then takes runs. */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const { inSave, aside } = socketDirs(this.root, this.home);
    await Promise.all([inSave, aside].map((dir) => rm(dir, { force: true, recursive: true })));
    this.started = true;
  }

  stop(): void {
    for (const [socket, server] of this.servers) {
      this.close(socket, server);
    }
    this.started = false;
  }

  /** Opens a run's socket, made by main, readable and writable by the founder's user alone. */
  async registerRun(caller: ToolCaller): Promise<RunHandle> {
    if (!this.started) {
      throw new Error("control plane not started");
    }
    const socket = runSocketPath(this.root, this.home, randomBytes(6).toString("hex"));
    const token = randomBytes(24).toString("base64url");
    const run: Run = { caller, token: Buffer.from(token) };
    await mkdir(path.dirname(socket), { mode: 0o700, recursive: true });
    const server = createServer((req, res) => {
      void handle(run, req, res);
    });
    await listen(server, socket);
    // the folder is the founder's alone, so nobody connects before this narrows the socket
    await chmod(socket, 0o600);
    this.servers.set(socket, server);
    return {
      env: { IDLEBIZ_API_SOCKET: socket, IDLEBIZ_RUN_TOKEN: token },
      release: () => {
        run.caller = null;
        this.close(socket, server);
      },
      socket,
    };
  }

  private close(socket: string, server: Server): void {
    this.servers.delete(socket);
    server.close();
    server.closeIdleConnections();
    rmSync(socket, { force: true });
  }
}

export const controlPlane = new ControlPlane();
