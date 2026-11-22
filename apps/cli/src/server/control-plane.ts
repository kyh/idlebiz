import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { listening } from "./lib/listening";
import { rootDir } from "./paths";
import { RefusalError } from "./refusal";
import { MAX_REQUEST_BYTES, toolAt } from "./tool-specs";
import type { ToolAnswer, ToolName, ToolOutcome } from "./tool-specs";
import { BadRequestError, errorMessage } from "@repo/domain/errors";
import { parseJson } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";

/** Answers one call of the tool `name`: how it ended, in prose the agent reads. */
export type ToolCaller = (name: ToolName, raw: JsonValue) => Promise<ToolOutcome>;

interface RunHandle {
  env: { IDLEBIZ_API_SOCKET: string; IDLEBIZ_RUN_TOKEN: string };
  socket: string;
  release: () => void;
}

/** The longest path macOS takes for a unix socket: `sun_path` holds 104 bytes, its NUL included. */
export const SOCKET_PATH_MAX_BYTES = 103;

const fits = (socket: string) => Buffer.byteLength(socket) <= SOCKET_PATH_MAX_BYTES;

interface SocketDirs {
  inSave: string;
  aside: string;
}

/**
 * Where runs' sockets go for the save at `root`: in the save beside its company folder, and, for
 * a save whose path is too long for that, a folder in HOME named for the save.
 * A run writes neither: the save but for its own folders, and HOME but for its runner's state.
 */
export const socketDirs = (root: string, home: string) =>
  ({
    aside: path.join(
      home,
      ".idlebiz-run",
      createHash("sha256").update(root).digest("hex").slice(0, 8),
    ),
    inSave: path.join(root, ".run"),
  }) satisfies SocketDirs;

/** The path of the socket `id` for the save at `root`: the first of `socketDirs` short enough for it. */
export const runSocketPath = (root: string, home: string, id: string) => {
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

const respond = (res: ServerResponse, status: number, payload: ToolAnswer) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
};

const readJsonBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;

    if (size <= MAX_REQUEST_BYTES) {
      chunks.push(buf);
    }
  }

  if (size > MAX_REQUEST_BYTES) {
    throw new BadRequestError(
      `The request is ${size} bytes, over the ${MAX_REQUEST_BYTES} a call may send.`,
    );
  }

  if (chunks.length === 0) {
    return {} satisfies JsonValue;
  }

  try {
    return parseJson(Buffer.concat(chunks).toString("utf-8"));
  } catch (error) {
    throw new BadRequestError(`The request is not JSON: ${errorMessage(error)}`);
  }
};

interface Run {
  token: Buffer;
  caller: ToolCaller | null;
}

const presented = (req: IncomingMessage) => {
  const header = req.headers.authorization ?? "";

  return Buffer.from(header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "");
};

const authenticate = (run: Run, req: IncomingMessage) => {
  const token = presented(req);
  const matches = token.length === run.token.length && timingSafeEqual(token, run.token);

  return matches ? run.caller : null;
};

const handle = async (run: Run, req: IncomingMessage, res: ServerResponse) => {
  try {
    const caller = authenticate(run, req);

    if (!caller) {
      respond(res, 401, { error: "unknown or expired run token", ok: false });

      return;
    }

    const [pathname = ""] = (req.url ?? "").split("?");
    const name = req.method === "POST" ? toolAt(pathname) : null;

    if (name === null) {
      const route = `${req.method ?? "GET"} ${pathname}`;
      respond(res, 404, { error: `no tool is served at ${route}`, ok: false });

      return;
    }

    const raw = await readJsonBody(req);

    if (authenticate(run, req) !== caller) {
      respond(res, 401, { error: "unknown or expired run token", ok: false });

      return;
    }

    respond(res, 200, { ...(await caller(name, raw)), ok: true });
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
  private readonly root: () => string;
  private readonly home: string;
  private readonly servers = new Map<string, { run: Run; server: Server }>();

  constructor(root: () => string = rootDir, home: string = homedir()) {
    this.root = root;
    this.home = home;
  }

  /** Sweeps the sockets a run cut off by a crash or a quit left behind, then takes runs. */
  async start() {
    if (this.started) {
      return;
    }

    const { inSave, aside } = socketDirs(this.root(), this.home);
    await Promise.all([inSave, aside].map((dir) => rm(dir, { force: true, recursive: true })));
    this.started = true;
  }

  stop() {
    for (const [socket, { run, server }] of this.servers) {
      run.caller = null;
      this.close(socket, server);
    }

    this.started = false;
  }

  /** Opens a run's socket, made by main, readable and writable by the founder's user alone. */
  async registerRun(caller: ToolCaller) {
    if (!this.started) {
      throw new Error("control plane not started");
    }

    const socket = runSocketPath(this.root(), this.home, randomBytes(6).toString("hex"));
    const token = randomBytes(24).toString("base64url");
    const run: Run = { caller, token: Buffer.from(token) };
    await mkdir(path.dirname(socket), { mode: 0o700, recursive: true });

    const server = createServer((req, res) => {
      void handle(run, req, res);
    });

    await listening(server, `a run's socket ${socket}`, () => {
      server.listen(socket);
    });
    await chmod(socket, 0o600);
    this.servers.set(socket, { run, server });

    return {
      env: { IDLEBIZ_API_SOCKET: socket, IDLEBIZ_RUN_TOKEN: token },
      release: () => {
        run.caller = null;
        this.close(socket, server);
      },
      socket,
    } satisfies RunHandle;
  }

  private close(socket: string, server: Server) {
    this.servers.delete(socket);
    server.close();
    server.closeIdleConnections();
    rmSync(socket, { force: true });
  }
}

export const controlPlane = new ControlPlane();
