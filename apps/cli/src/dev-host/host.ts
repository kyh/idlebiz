import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  copyTextSchema,
  handoffSchema,
  installUpdateSchema,
  keepAwakeSchema,
  loginItemSchema,
  messageBoxSchema,
  noteSchema,
  openingSchema,
  trayModelSchema,
} from "../server/host";
import type { LaunchHello, RelayMethod } from "../server/host";
import { createPeer } from "../server/relay/rpc";
import type { Peer } from "../server/relay/rpc";
import { errorMessage } from "@repo/domain/errors";

const SERVE_ENTRY = path.resolve(import.meta.dirname, "../../dist/index.js");

const BOOT_TIMEOUT_MS = 60_000;
const HANDOFF_TIMEOUT_MS = 10_000;
const QUIT_TIMEOUT_MS = 45_000;
const EXIT_GRACE_MS = 5000;

class MainLateError extends Error {
  override name = "MainLateError";
}

const within = async <T>(answer: Promise<T>, ms: number, what: string) => {
  const deadline = new AbortController();

  try {
    return await Promise.race([
      answer,
      sleep(ms, undefined, { ref: false, signal: deadline.signal }).then(() => {
        throw new MainLateError(`main did not ${what} within ${ms / 1000} seconds`);
      }),
    ]);
  } finally {
    deadline.abort();
  }
};

export interface DevHostOptions {
  /** The save main opens (`IDLEBIZ_ROOT_DIR`); the environment's when absent. */
  root?: string;
  /** Node flags before main's entry: e2e preloads its stand-ins for the services main calls. */
  nodeArgs?: readonly string[];
  /** More of main's environment, over what it inherits. */
  env?: NodeJS.ProcessEnv;
  /**
   * Which of the terminal's variables main inherits, besides the loaders it never does: every one
   * when absent. e2e refuses the terminal's provider logins, so no run can bill a real one.
   */
  inherit?: (name: string) => boolean;
  /** Where the host's own lines and main's stderr go. */
  log: (line: string) => void;
  /** Vite's dev server, whose files main hands the page in place of the built ones. */
  pageDevUrl?: string;
}

export interface DevHost {
  /** A link that signs a browser in to main's page, once, within five minutes, as the window is. */
  handoff: () => Promise<string>;
  /** Stops main's runs and starts main again, as a relaunch does. */
  restartMain: () => Promise<void>;
  /** Stops main's runs, then main. */
  stop: () => Promise<void>;
  /** What main asked to be copied to the clipboard, oldest first. */
  copied: readonly string[];
}

type MainChild = ChildProcessByStdio<Writable, Readable, Readable>;

interface Main {
  child: MainChild;
  peer: Peer<RelayMethod>;
}

const NODE_LOADERS = ["NODE_", "OPENSSL_"] as const;

/**
 * Main's environment as a development shell gives it, its terminal's: no `NODE_*` (a loader, an
 * inspector, a mode), no `OPENSSL_*` (a config node reads as it starts) and none `inherit`
 * refuses. Main is told it is not packaged, so the packaged app's account and PATH resets are not
 * the dev host's to make.
 */
export const mainEnv = (options: DevHostOptions) => {
  const { inherit = () => true } = options;
  const env: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (!NODE_LOADERS.some((prefix) => name.startsWith(prefix)) && inherit(name)) {
      env[name] = value;
    }
  }

  if (options.root !== undefined) {
    env.IDLEBIZ_ROOT_DIR = options.root;
  }

  return { ...env, ...options.env } satisfies NodeJS.ProcessEnv;
};

const exitOf = (child: MainChild) =>
  child.exitCode === null ? String(child.signalCode) : `code ${child.exitCode}`;

const isRunning = (child: MainChild) => child.exitCode === null && child.signalCode === null;

const linesOf = (stream: Readable) =>
  createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: stream });

export const startDevHost = async (options: DevHostOptions) => {
  const { log } = options;
  const copied: string[] = [];
  const asks = new EventTarget();
  let main: Main | null = null;
  let turn: Promise<void> = Promise.resolve();
  let stopped = false;

  const listen = (peer: Peer<RelayMethod>) => {
    peer.handle("host.messageBox", messageBoxSchema, (box) => {
      log(`[host] ${box.kind}: ${box.message}${box.detail === null ? "" : `\n${box.detail}`}`);

      return null;
    });
    peer.handle("host.copyText", copyTextSchema, (copy) => {
      copied.push(copy.text);

      return null;
    });
    peer.handle("host.open", openingSchema, (opening) => {
      log(`[host] main asked to open (${opening.kind}) ${opening.target}`);

      return null;
    });
    peer.handle("host.loginItem", loginItemSchema, () => "unavailable");
    peer.handle("host.checkUpdate", z.null(), () => {
      throw new Error("only the installed app updates itself");
    });
    peer.handle("host.installUpdate", installUpdateSchema, () => {
      throw new Error("only the installed app updates itself");
    });
    peer.on("host.notify", noteSchema, ({ body, title }) => {
      log(`[host] notification: ${title} — ${body}`);
    });
    peer.on("host.tray", trayModelSchema, () => null);
    peer.on("host.keepAwake", keepAwakeSchema, () => null);
    peer.on("host.relaunch", z.null(), () => {
      log("[host] main asked for a relaunch");
      asks.dispatchEvent(new Event("relaunch"));
    });
  };

  const killMain = async (running: Main) => {
    if (!isRunning(running.child) || running.child.pid === undefined) {
      return;
    }

    const exited = once(running.child, "exit");
    process.kill(-running.child.pid, "SIGKILL");
    await exited;
  };

  const stopMain = async (running: Main) => {
    if (!isRunning(running.child)) {
      return;
    }

    const exited = once(running.child, "exit");

    const answered = async () => {
      try {
        await running.peer.request("quit", null, z.null());
      } catch (error) {
        log(`[host] main did not answer quit: ${errorMessage(error)}`);
      }
    };

    await Promise.race([answered(), sleep(QUIT_TIMEOUT_MS, undefined, { ref: false })]);
    running.child.stdin.end();
    await Promise.race([exited, sleep(EXIT_GRACE_MS, undefined, { ref: false })]);
    await killMain(running);
  };

  const startMain = async () => {
    const child = spawn(process.execPath, [...(options.nodeArgs ?? []), SERVE_ENTRY, "serve"], {
      detached: true,
      env: mainEnv(options),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const peer = createPeer<RelayMethod>({
      failed: (method, reason) => {
        log(`[dev-host] what the host does on ${method} failed: ${reason}`);
      },
      stray: (line) => {
        log(`[main] ${line}`);
      },
      write: (line) => {
        child.stdin.write(`${line}\n`);
      },
    });

    listen(peer);
    linesOf(child.stdout).on("line", (line) => {
      peer.receive(line);
    });
    linesOf(child.stderr).on("line", (line) => {
      log(`[main] ${line}`);
    });
    child.stdin.on("error", (error) => {
      log(`[host] main's stdin: ${error.message}`);
    });
    child.once("error", (error) => {
      peer.close(`main could not start: ${error.message}`);
      log(`[host] main could not start: ${error.message}`);
    });
    child.once("exit", () => {
      peer.close("main is gone");
      log(`[host] main exited (${exitOf(child)})`);
    });
    const started = { child, peer };

    const hello: LaunchHello = {
      openedAtLogin: false,
      packaged: false,
      pageDevUrl: options.pageDevUrl ?? null,
      vault: null,
    };

    try {
      await within(peer.request("hello", hello, z.null()), BOOT_TIMEOUT_MS, "boot");
    } catch (error) {
      await (error instanceof MainLateError ? killMain(started) : stopMain(started));
      throw new Error(`main did not boot: ${errorMessage(error)}`, { cause: error });
    }

    return started;
  };

  const queue = async (step: () => Promise<void>) => {
    const previous = turn;

    const current = (async () => {
      await Promise.allSettled([previous]);
      await step();
    })();

    turn = current;
    await current;
  };

  const restartMain = async () => {
    await queue(async () => {
      if (stopped) {
        return;
      }

      if (main !== null) {
        await stopMain(main);
        main = null;
      }

      main = await startMain();
      log("[host] main started again");
    });
  };

  asks.addEventListener("relaunch", () => {
    void (async () => {
      try {
        await restartMain();
      } catch (error) {
        log(`[host] main did not start again: ${errorMessage(error)}`);
      }
    })();
  });

  const stop = async () => {
    await queue(async () => {
      stopped = true;

      if (main !== null) {
        await stopMain(main);
        main = null;
      }
    });
  };

  const handoff = async () => {
    if (main === null) {
      throw new Error("main is not running");
    }

    const { handoffUrl } = await within(
      main.peer.request("handoff", null, handoffSchema),
      HANDOFF_TIMEOUT_MS,
      "hand over a link",
    );

    return handoffUrl;
  };

  main = await startMain();

  return { copied, handoff, restartMain, stop } satisfies DevHost;
};
