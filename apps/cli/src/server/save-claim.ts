import { mkdir, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Server } from "node:net";
import path from "node:path";
import { z } from "zod";
import { SOCKET_PATH_MAX_BYTES, socketDirs } from "./control-plane";
import { RefusalError } from "./refusal";

// One main per save: two would drain one queue, each task paid for twice. Main holds the save by
// listening on a unix socket named for it for as long as it runs. A lock file would outlive a
// crash; a listener ends with its process, however it dies, and leaves a file nothing answers on.

export interface SaveClaim {
  /** Lets the save go: the socket closes, and its file goes with it. */
  release: () => void;
}

/** How a connect to a socket's file fails when no main holds it: none listens, it is gone, or it is no socket. */
const UNHELD = new Set(["ECONNREFUSED", "ENOENT", "ENOTSOCK"]);

const Errno = z.object({ code: z.string() });

const codeOf = (error: Error): string | null => Errno.safeParse(error).data?.code ?? null;

/**
 * Where main claims the save at `root`: in the save beside its company folder, or, for a save
 * whose path is too long for that, beside the folder its runs' sockets take in HOME.
 */
export const claimSocketPath = (root: string, home: string): string => {
  const candidates = [path.join(root, ".main.sock"), `${socketDirs(root, home).aside}.sock`];
  const socket = candidates.find(
    (candidate) => Buffer.byteLength(candidate) <= SOCKET_PATH_MAX_BYTES,
  );
  if (socket === undefined) {
    throw new RefusalError(
      `IdleBiz could not claim its save: a socket at ${candidates.join(" or ")} would be longer than the ${SOCKET_PATH_MAX_BYTES} bytes macOS allows its path. Move the save (IDLEBIZ_ROOT_DIR) or your home to a shorter path.`,
    );
  }
  return socket;
};

/** A server holding `socket`, or null when its file is already there. */
const listenOn = async (socket: string): Promise<Server | null> => {
  // a connect is all a second main asks of it
  const server = createServer((connection) => {
    connection.destroy();
  });
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
  return await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (codeOf(error) === "EADDRINUSE") {
        resolve(null);
      } else {
        reject(error);
      }
    });
    server.listen(socket, () => {
      resolve(server);
    });
  });
};

/** Whether a main answers on `socket`. */
const answers = async (socket: string): Promise<boolean> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps a callback API
  await new Promise((resolve, reject) => {
    const probe = createConnection(socket);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error) => {
      const code = codeOf(error);
      if (code !== null && UNHELD.has(code)) {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });

/** Holds `socket`, clearing a file a crashed main left there, `retries` times at most. */
const hold = async (socket: string, root: string, retries: number): Promise<Server> => {
  const server = await listenOn(socket);
  if (server !== null) {
    return server;
  }
  if (await answers(socket)) {
    throw new RefusalError(
      `IdleBiz is already open on this save (${root}). Quit it first, or start this one on a save of its own (IDLEBIZ_ROOT_DIR).`,
    );
  }
  if (retries === 0) {
    throw new Error(
      `IdleBiz could not claim its save: ${socket} is taken, and nothing answers on it`,
    );
  }
  await rm(socket, { force: true });
  return await hold(socket, root, retries - 1);
};

/**
 * Claims the save at `root` for this main, before anything reads it; refuses when another main
 * holds it. A main that crashed holds nothing, and the file it left is cleared.
 */
export const claimSave = async (root: string, home: string): Promise<SaveClaim> => {
  const socket = claimSocketPath(root, home);
  await mkdir(path.dirname(socket), { recursive: true });
  const server = await hold(socket, root, 1);
  return {
    release: () => {
      server.close();
    },
  };
};
