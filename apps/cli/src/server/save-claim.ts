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

// One main per save: two would drain one queue, each task paid for twice. Main holds the save by
// listening on a unix socket in the save's claim folder for as long as it runs. A lock file would
// outlive a crash; a listener ends with its process, however it dies, and leaves a file nothing
// answers on. Each main's socket takes a name of its own and appears there only once it answers,
// so a file that answers nothing never will, and any main may clear it: a main clearing a crash's
// file late clears no live main's, as it would were every claim made on one path.

export interface SaveClaim {
  /** Lets the save go: the socket closes, and its file goes with it. */
  release: () => void;
}

/** How a connect to a socket's file fails when no main holds it: none listens, it is gone, or it is no socket. */
const UNHELD = new Set(["ECONNREFUSED", "ENOENT", "ENOTSOCK"]);

/** How publishing a socket fails when a name it drew is not its own: cleared before it answered, or drawn twice. */
const LOST = new Set(["ENOENT", "EEXIST"]);

const ID_BYTES = 8;

/** The longest name a main gives a file in the claim's folder. */
const LONGEST_NAME = `${"0".repeat(ID_BYTES * 2)}.sock`;

/** How many names a main draws for its socket before it gives up. */
const DRAWS = 3;

/** How many tries a main makes at the save, finding another answering at each, before it refuses. */
const CONTESTS = 3;

/** The longest a main steps back before it tries again. */
const BACKOFF_MS = 100;

const Errno = z.object({ code: z.string() });

const codeOf = (error: Error): string | null => Errno.safeParse(error).data?.code ?? null;

/**
 * The folder main claims the save at `root` in: in the save beside its company folder, or, for a
 * save whose path is too long for that, beside the folder its runs' sockets take in HOME.
 */
export const claimDir = (root: string, home: string): string => {
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

/** A server holding `socket`, or null when its file is already there. */
const listenOn = async (socket: string): Promise<Server | null> => {
  // a connect is all a second main asks of it
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

/** Whether a main answers on `socket`. */
const answers = async (socket: string): Promise<boolean> => {
  const probe = createConnection(socket);
  // the wait below stops hearing errors once it connects, but the claim's server ends each
  // connection it takes, so the probe can still fail after: unheard, that would take main down
  probe.on("error", () => {
    // what answers is heard below; a failure after the connect changes nothing
  });
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

/**
 * This main's socket in `dir`, under a name that appears only once it answers; null when the name
 * it drew was lost.
 */
const tryPublish = async (dir: string): Promise<Published | null> => {
  const id = randomBytes(ID_BYTES).toString("hex");
  const bound = path.join(dir, `${id}.new`);
  const server = await listenOn(bound);
  if (server === null) {
    return null;
  }
  const socket = path.join(dir, `${id}.sock`);
  try {
    // a link refuses a name already there, where a rename would replace a live main's
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
  return { server, socket };
};

/** This main's socket in `dir`, drawing a name for it `draws` times at most. */
const publish = async (dir: string, draws: number): Promise<Published> => {
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

/** Closes this main's socket, and its file goes with it. */
const letGo = ({ server, socket }: Published): void => {
  server.close();
  rmSync(socket, { force: true });
};

/** Whether a main answers in `dir` on any socket but `own`'s, clearing each that answers nothing. */
const heldBesides = async (dir: string, own: Published): Promise<boolean> => {
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

/**
 * Holds the save from `dir`. A main claiming at the same moment answers as one that holds, so a
 * main that finds another lets go, steps back a while of its own and tries again, `contests` times
 * in all, before it refuses: of mains claiming together one holds, and never two.
 */
const hold = async (dir: string, root: string, contests: number): Promise<SaveClaim> => {
  const own = await publish(dir, DRAWS);
  if (!(await heldBesides(dir, own))) {
    return {
      release: () => {
        letGo(own);
      },
    };
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
export const claimSave = async (root: string, home: string): Promise<SaveClaim> => {
  const dir = claimDir(root, home);
  await mkdir(dir, { recursive: true });
  return await hold(dir, root, CONTESTS);
};
