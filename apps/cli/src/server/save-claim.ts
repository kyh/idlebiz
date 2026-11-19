import { randomBytes, randomInt } from "node:crypto";
import { rmSync } from "node:fs";
import { link, mkdir, readdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import type { Server } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { SOCKET_PATH_MAX_BYTES, socketDirs } from "./control-plane";
import { listening } from "./lib/listening";
import { RefusalError } from "./refusal";

export interface SaveClaim {
  /** Lets the save go: the socket closes, and its file goes with it. */
  release: () => void;
}

const UNHELD = new Set(["ECONNREFUSED", "ENOENT", "ENOTSOCK"]);

const LOST = new Set(["ENOENT", "EEXIST"]);

const ID_BYTES = 8;

const LONGEST_NAME = `${"0".repeat(ID_BYTES * 2)}.sock`;

const DRAWS = 3;

const CONTESTS = 3;

const BACKOFF_MS = 100;

const Errno = z.object({ code: z.string() });

const codeOf = (error: Error) => Errno.safeParse(error).data?.code ?? null;

/**
 * The folder main claims the save at `root` in: in the save beside its company folder, or, for a
 * save whose path is too long for that, beside the folder its runs' sockets take in HOME.
 */
export const claimDir = (root: string, home: string) => {
  const candidates = [path.join(root, ".main"), `${socketDirs(root, home).aside}.main`];

  const dir = candidates.find(
    (candidate) => Buffer.byteLength(path.join(candidate, LONGEST_NAME)) <= SOCKET_PATH_MAX_BYTES,
  );

  if (dir === undefined) {
    throw new RefusalError(
      `IdleBiz could not claim its save: a socket in ${candidates.join(" or ")} would be longer than the ${SOCKET_PATH_MAX_BYTES} bytes macOS allows its path. Move the save (IDLEBIZ_ROOT_DIR) or your home to a shorter path.`,
    );
  }

  return dir;
};

const listenOn = async (socket: string) => {
  const server = createServer((connection) => {
    connection.destroy();
  });

  try {
    await listening(server, "the save's claim", () => {
      server.listen(socket);
    });
  } catch (error) {
    if (error instanceof Error && codeOf(error) === "EADDRINUSE") {
      return null;
    }

    throw error;
  }

  return server;
};

const answers = async (socket: string) => {
  const probe = createConnection(socket);
  probe.on("error", () => null);

  try {
    await once(probe, "connect");
  } catch (error) {
    const code = error instanceof Error ? codeOf(error) : null;

    if (code !== null && UNHELD.has(code)) {
      return false;
    }

    throw error;
  }

  probe.destroy();

  return true;
};

interface Published {
  server: Server;
  socket: string;
}

const tryPublish = async (dir: string) => {
  const id = randomBytes(ID_BYTES).toString("hex");
  const bound = path.join(dir, `${id}.new`);
  const server = await listenOn(bound);

  if (server === null) {
    return null;
  }

  const socket = path.join(dir, `${id}.sock`);

  try {
    await link(bound, socket);
  } catch (error) {
    server.close();
    const code = Errno.safeParse(error).data?.code;

    if (code !== undefined && LOST.has(code)) {
      return null;
    }

    throw error;
  }

  await rm(bound, { force: true });

  return { server, socket } satisfies Published | null;
};

const publish = async (dir: string, draws: number) => {
  const own = await tryPublish(dir);

  if (own !== null) {
    return own;
  }

  if (draws <= 1) {
    throw new Error(
      `IdleBiz could not claim its save: none of ${DRAWS} names drawn for its socket in ${dir} stayed its own`,
    );
  }

  return await publish(dir, draws - 1);
};

const letGo = ({ server, socket }: Published) => {
  server.close();
  rmSync(socket, { force: true });
};

const heldBesides = async (dir: string, own: Published) => {
  try {
    const names = await readdir(dir);

    const others = names
      .map((name) => path.join(dir, name))
      .filter((entry) => entry !== own.socket);

    const held = await Promise.all(
      others.map(async (entry) => {
        if (await answers(entry)) {
          return true;
        }

        await rm(entry, { force: true });

        return false;
      }),
    );

    return held.includes(true);
  } catch (error) {
    letGo(own);
    throw error;
  }
};

const hold = async (dir: string, root: string, contests: number) => {
  const own = await publish(dir, DRAWS);

  if (!(await heldBesides(dir, own))) {
    return {
      release: () => {
        letGo(own);
      },
    } satisfies SaveClaim;
  }

  letGo(own);

  if (contests <= 1) {
    throw new RefusalError(
      `IdleBiz is already open on this save (${root}). Quit it first, or start this one on a save of its own (IDLEBIZ_ROOT_DIR).`,
    );
  }

  await delay(randomInt(BACKOFF_MS));

  return await hold(dir, root, contests - 1);
};

/**
 * Claims the save at `root` for this main, before anything reads it; refuses when another main
 * holds it. A main that crashed holds nothing, and the file it left is cleared.
 */
export const claimSave = async (root: string, home: string) => {
  const dir = claimDir(root, home);
  await mkdir(dir, { recursive: true });

  return await hold(dir, root, CONTESTS);
};
