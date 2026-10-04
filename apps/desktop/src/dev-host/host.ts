// The dev host: main as the desktop shell runs it, with a browser where the shell's window would be.
// It starts the built main (`.output/main/index.js`) on this node, says hello as the shell does (the
// checkout's resources, the page main serves, and the mock keychain's password a development build
// seals with), and answers main's asks of a native app itself: a message box, a notification and
// the menu-bar icon are logged, the login item is unavailable, a relaunch starts main again.
//
// A browser reaches main as the shell's window does: on main's own page (src/main/page-server.ts),
// signed in by a link `handoff` asks main for. Nothing of this ships.

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { handoffSchema } from "@/main/host";
import { MOCK_KEYCHAIN_PASSWORD } from "@/main/lib/os-crypt";
import { createPeer } from "@/main/relay/rpc";
import type { Peer } from "@/main/relay/rpc";
import { errorMessage } from "@/shared/errors";
import { jsonValueSchema } from "@/shared/json";

export const DESKTOP_DIR = path.resolve(import.meta.dirname, "../..");
const MAIN_ENTRY = path.join(DESKTOP_DIR, ".output/main/index.js");
/** The page as `pnpm build` leaves it, which main serves when no dev server is named. */
const PAGE_DIR = path.join(DESKTOP_DIR, ".output/renderer");

/** How long a quit waits for main to stop its runs, as the shell waits (main_process.rs). */
const QUIT_TIMEOUT_MS = 45_000;
/** How long main has to exit once its stdin closes, before SIGKILL. */
const EXIT_GRACE_MS = 5000;

export interface DevHostOptions {
  /** The save main opens (`IDLEBIZ_ROOT_DIR`); the environment's when absent. */
  root?: string;
  /** Node flags before main's entry: e2e preloads its stand-ins for the services main calls. */
  nodeArgs?: readonly string[];
  /** More of main's environment. */
  env?: NodeJS.ProcessEnv;
  /** Where the host's own lines and main's stderr go. */
  log: (line: string) => void;
  /** Vite's dev server, whose files main hands the page in place of the built ones. */
  pageDevUrl?: string;
}

/** What main asked the system to open: a URL in the browser, a file or folder in Finder. */
export interface Opening {
  kind: "path" | "reveal" | "url";
  target: string;
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
  /** What main asked the system to open, oldest first: the dev host opens nothing. */
  opened: readonly Opening[];
}

type MainChild = ChildProcessByStdio<Writable, Readable, Readable>;

interface Main {
  child: MainChild;
  peer: Peer;
}

const messageBoxSchema = z.object({
  detail: z.string().nullable(),
  kind: z.enum(["info", "warning", "error"]),
  message: z.string(),
});
const openingSchema = z.object({ kind: z.enum(["path", "reveal", "url"]), target: z.string() });
const noteSchema = z.object({ body: z.string(), title: z.string() });

/** Main's environment as the shell gives it: no `NODE_*` (a loader, an inspector, a mode). */
const mainEnv = (options: DevHostOptions): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("NODE_")) {
      env[name] = value;
    }
  }
  if (options.root !== undefined) {
    env.IDLEBIZ_ROOT_DIR = options.root;
  }
  return { ...env, ...options.env };
};

const exitOf = (child: MainChild): string =>
  child.exitCode === null ? String(child.signalCode) : `code ${child.exitCode}`;

const isRunning = (child: MainChild): boolean =>
  child.exitCode === null && child.signalCode === null;

const linesOf = (stream: Readable) =>
  createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: stream });

export const startDevHost = async (options: DevHostOptions): Promise<DevHost> => {
  const { log } = options;
  const copied: string[] = [];
  const opened: Opening[] = [];
  // main's own ask to restart it, heard once the restart below exists
  const asks = new EventTarget();
  let main: Main | null = null;
  // a restart and a stop wait their turn, so main is never started twice over one save
  let turn: Promise<void> = Promise.resolve();
  let stopped = false;

  const listen = (peer: Peer): void => {
    peer.handle("host.messageBox", messageBoxSchema, (box) => {
      log(`[host] ${box.kind}: ${box.message}${box.detail === null ? "" : `\n${box.detail}`}`);
      return null;
    });
    peer.handle("host.copyText", z.object({ text: z.string() }), (copy) => {
      copied.push(copy.text);
      return null;
    });
    peer.handle("host.open", openingSchema, (opening) => {
      opened.push(opening);
      log(`[host] main asked to open (${opening.kind}) ${opening.target}`);
      return null;
    });
    peer.handle("host.loginItem", z.object({ on: z.boolean().nullable() }), () => "unavailable");
    peer.on("host.notify", noteSchema, ({ body, title }) => {
      log(`[host] notification: ${title} — ${body}`);
    });
    peer.on("host.tray", jsonValueSchema, () => {
      // the menu-bar icon is the shell's to draw
    });
    peer.on("host.keepAwake", jsonValueSchema, () => {
      // keeping the Mac awake is the shell's to hold
    });
    peer.on("host.relaunch", z.null(), () => {
      log("[host] main asked for a relaunch");
      asks.dispatchEvent(new Event("relaunch"));
    });
  };

  const stopMain = async (running: Main): Promise<void> => {
    if (!isRunning(running.child)) {
      return;
    }
    const exited = once(running.child, "exit");
    const answered = async (): Promise<void> => {
      try {
        await running.peer.request("quit", null, z.null());
      } catch (error) {
        log(`[host] main did not answer quit: ${errorMessage(error)}`);
      }
    };
    // unreferenced, so a deadline its race no longer needs holds no process open
    await Promise.race([answered(), sleep(QUIT_TIMEOUT_MS, undefined, { ref: false })]);
    running.child.stdin.end();
    await Promise.race([exited, sleep(EXIT_GRACE_MS, undefined, { ref: false })]);
    if (isRunning(running.child) && running.child.pid !== undefined) {
      // main leads its own group: what it started and did not end goes with it
      process.kill(-running.child.pid, "SIGKILL");
      await exited;
    }
  };

  const startMain = async (): Promise<Main> => {
    const child = spawn(process.execPath, [...(options.nodeArgs ?? []), MAIN_ENTRY], {
      cwd: DESKTOP_DIR,
      // a group of its own: a Ctrl-C in the terminal reaches the dev server alone, and main ends
      // when its stdin does, after its runs, as it does under the shell
      detached: true,
      env: mainEnv(options),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const peer = createPeer({
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
      // a write after main is gone fails here, not as an uncaught error in the host
      log(`[host] main's stdin: ${error.message}`);
    });
    // a child that never ran exits never: its hello fails with the reason instead of waiting on it
    child.once("error", (error) => {
      peer.close(`main could not start: ${error.message}`);
      log(`[host] main could not start: ${error.message}`);
    });
    child.once("exit", () => {
      peer.close("main is gone");
      log(`[host] main exited (${exitOf(child)})`);
    });
    const started = { child, peer };
    try {
      await peer.request(
        "hello",
        {
          openedAtLogin: false,
          packaged: false,
          pageDevUrl: options.pageDevUrl ?? null,
          pageDir: PAGE_DIR,
          resourcesDir: path.join(DESKTOP_DIR, "resources"),
          safeStoragePassword: MOCK_KEYCHAIN_PASSWORD,
        },
        z.null(),
      );
    } catch (error) {
      await stopMain(started);
      throw new Error(`main did not boot: ${errorMessage(error)}`, { cause: error });
    }
    return started;
  };

  const queue = async (step: () => Promise<void>): Promise<void> => {
    const previous = turn;
    const current = (async () => {
      await Promise.allSettled([previous]);
      await step();
    })();
    turn = current;
    await current;
  };

  const restartMain = async (): Promise<void> => {
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

  const stop = async (): Promise<void> => {
    await queue(async () => {
      stopped = true;
      if (main !== null) {
        await stopMain(main);
        main = null;
      }
    });
  };

  const handoff = async (): Promise<string> => {
    if (main === null) {
      throw new Error("main is not running");
    }
    const { handoffUrl } = await main.peer.request("handoff", null, handoffSchema);
    return handoffUrl;
  };

  main = await startMain();
  return { copied, handoff, opened, restartMain, stop };
};
