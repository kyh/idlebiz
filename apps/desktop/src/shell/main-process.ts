import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { JsonValue } from "@repo/domain/json";
import { createPeer } from "idlebiz/relay";
import type { Peer } from "idlebiz/relay";

const QUIT_TIMEOUT_MS = 45_000;

const EXIT_GRACE_MS = 5000;

/** Main asked something it did not answer within the time it was given. */
export class MainLateError extends Error {
  override name = "MainLateError";
}

export interface MainSpec<M extends string> {
  node: string;
  entry: string;
  args: readonly string[];
  /** The method main stops its runs on and answers. */
  quit: M;
  env: Record<string, string>;
  /** Main's own lines, as it printed them. */
  log: (line: string) => void;
  /** The supervisor's lines about main. */
  note: (line: string) => void;
  quitTimeoutMs?: number;
  exitGraceMs?: number;
}

export interface MainHost<M extends string> {
  /** Answers and hears what main asks and tells, on the peer that speaks to it. */
  listen: (peer: Peer<M>) => void;
  /** Main is gone with no stop asked of it, with its exit code (null for a signal). */
  lost: (code: number | null) => void;
}

type MainChild = ChildProcessByStdio<Writable, Readable, Readable>;

const linesOf = (stream: Readable) =>
  createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: stream });

/** How main ended, for a log or a box. */
export const describeExit = (code: number | null) => (code === null ? "a signal" : `code ${code}`);

const timer = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<"late">();

  const handle = setTimeout(() => {
    resolve("late");
  }, ms);

  handle.unref();

  return { cancel: () => clearTimeout(handle), promise };
};

/**
 * Main as the shell's one child, in a process group of its own so a signal to the shell's reaches
 * the shell alone, which stops main once, after its runs. Its stdin is its lifeline, closed only
 * once main has answered `quit` or a stop has given up on it.
 */
export const startMain = <M extends string>(spec: MainSpec<M>, host: MainHost<M>) => {
  const quitTimeoutMs = spec.quitTimeoutMs ?? QUIT_TIMEOUT_MS;
  const exitGraceMs = spec.exitGraceMs ?? EXIT_GRACE_MS;
  spec.note("[shell] starting main");

  const child: MainChild = spawn(spec.node, [spec.entry, ...spec.args], {
    detached: true,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let exited = false;
  let stopping: Promise<unknown> | null = null;
  const exit = Promise.withResolvers<null>();

  const peer = createPeer<M>({
    failed: (method, reason) => {
      spec.note(`[shell] what the shell does on ${method} failed: ${reason}`);
    },
    stray: (line) => {
      spec.note(`[main] ${line}`);
    },
    write: (line) => {
      if (!exited && child.stdin.writable) {
        child.stdin.write(`${line}\n`);
      }
    },
  });

  host.listen(peer);
  linesOf(child.stdout).on("line", (line) => {
    peer.receive(line);
  });
  linesOf(child.stderr).on("line", (line) => {
    console.error(`[main] ${line}`);
    spec.log(line);
  });
  child.stdin.on("error", (error) => {
    spec.note(`[shell] main's stdin: ${error.message}`);
  });

  const ended = (code: number | null, why: string) => {
    if (exited) {
      return;
    }

    exited = true;
    spec.note(why);
    peer.close("main is gone");
    exit.resolve(null);

    if (stopping === null) {
      host.lost(code);
    }
  };

  child.once("error", (error) => {
    ended(null, `[shell] main could not start (${spec.node}): ${error.message}`);
  });
  child.once("exit", (code) => {
    ended(code, `main exited (${describeExit(code)})`);
  });

  const waitExit = async (ms: number) => {
    const late = timer(ms);
    const outcome = await Promise.race([exit.promise.then(() => "exited" as const), late.promise]);
    late.cancel();

    return outcome === "exited";
  };

  const killGroup = () => {
    if (child.pid !== undefined && !exited) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        spec.note(`[shell] could not kill main's group: ${String(error)}`);
      }
    }
  };

  const request = async <R>(method: M, params: JsonValue, schema: z.ZodType<R>, ms: number) => {
    if (exited || !child.stdin.writable) {
      throw new Error("main is not running");
    }

    const late = timer(ms);

    try {
      const answer = await Promise.race([peer.request(method, params, schema), late.promise]);

      if (answer === "late") {
        throw new MainLateError(`main did not answer ${method} within ${ms / 1000} seconds`);
      }

      return answer;
    } finally {
      late.cancel();
    }
  };

  const kill = async () => {
    stopping ??= Promise.resolve();
    child.stdin.destroy();
    killGroup();
    await waitExit(exitGraceMs);
  };

  const runStop = async () => {
    try {
      await request(spec.quit, null, z.null(), quitTimeoutMs);
    } catch {
      spec.note("[shell] main did not answer quit in time; closing it anyway");
    }

    child.stdin.end();

    if (!(await waitExit(exitGraceMs))) {
      spec.note("[shell] main did not exit once its stdin closed; sending SIGKILL");
      killGroup();
      await waitExit(exitGraceMs);
    }
  };

  return {
    boot: async <R>(method: M, hello: JsonValue, schema: z.ZodType<R>, ms: number) => {
      try {
        return await request(method, hello, schema, ms);
      } catch (error) {
        if (error instanceof MainLateError) {
          spec.note(`[shell] main did not boot within ${ms / 1000} seconds; killing it`);
          await kill();
        }

        throw error;
      }
    },
    exited: () => exited,
    notify: (method: M, params: JsonValue) => {
      if (!exited) {
        peer.notify(method, params);
      }
    },
    request,
    stop: async () => {
      if (exited) {
        return;
      }

      stopping ??= runStop();
      await stopping;
      await waitExit(exitGraceMs);
    },
  };
};

export type MainProcess<M extends string> = ReturnType<typeof startMain<M>>;
