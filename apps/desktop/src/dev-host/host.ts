// The dev host: main as the desktop shell runs it, with a browser where the shell's window would be.
// It starts the built main (`.output/main/index.js`) on this node, says hello as the shell does (the
// checkout's resources, and the mock keychain's password a development build seals with), and
// answers main's asks of a native app itself: a message box, a notification and the menu-bar icon
// are logged, the login item is unavailable, a relaunch starts main again.
//
// A page reaches main through `middleware`, mounted on the origin that serves the page (the dev
// server's under `pnpm dev:browser`, the built page's in e2e): POST `<bridge>/invoke` and a
// server-sent stream of main's events at `<bridge>/events`, both behind a token minted per host,
// which the page reads from its URL's fragment. Nothing of this ships: the app's window reaches main
// through the shell (src-tauri/src/commands.rs).

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { MOCK_KEYCHAIN_PASSWORD } from "@/main/lib/os-crypt";
import { createPeer } from "@/main/relay/rpc";
import type { Peer } from "@/main/relay/rpc";
import { DEV_BRIDGE_PATH } from "@/shared/dev-bridge";
import { errorMessage } from "@/shared/errors";
import { jsonValueSchema, parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";

export const DESKTOP_DIR = path.resolve(import.meta.dirname, "../..");
const MAIN_ENTRY = path.join(DESKTOP_DIR, ".output/main/index.js");

/** How long a quit waits for main to stop its runs, as the shell waits (main_process.rs). */
const QUIT_TIMEOUT_MS = 45_000;
/** How long main has to exit once its stdin closes, before SIGKILL. */
const EXIT_GRACE_MS = 5000;
/** The largest invoke a page sends: a pasted key, a long answer to a question. */
const MAX_INVOKE_BYTES = 1024 * 1024;

export interface DevHostOptions {
  /** The save main opens (`IDLEBIZ_ROOT_DIR`); the environment's when absent. */
  root?: string;
  /** Node flags before main's entry: e2e preloads its stand-ins for the services main calls. */
  nodeArgs?: readonly string[];
  /** More of main's environment. */
  env?: NodeJS.ProcessEnv;
  /** Where the host's own lines and main's stderr go. */
  log: (line: string) => void;
}

/** What main asked the system to open: a URL in the browser, a file or folder in Finder. */
export interface Opening {
  kind: "path" | "reveal" | "url";
  target: string;
}

export interface DevHost {
  /** The URL fragment a page carries to reach main, without its `#`. */
  fragment: string;
  /** Answers the bridge's paths; anything else goes to `next`. */
  middleware: (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
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

const invokeSchema = z.object({ method: z.string().min(1), payload: jsonValueSchema.optional() });
const messageBoxSchema = z.object({
  detail: z.string().nullable(),
  kind: z.enum(["info", "warning", "error"]),
  message: z.string(),
});
const openingSchema = z.object({ kind: z.enum(["path", "reveal", "url"]), target: z.string() });
const eventSchema = z.object({ channel: z.string(), data: jsonValueSchema });
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

const sameToken = (given: string | null, token: string): boolean => {
  if (given === null) {
    return false;
  }
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const bearer = (request: IncomingMessage): string | null => {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : null;
};

/**
 * An invoke's body, or null for one past the cap or no invoke at all. The cap is held to the length
 * the request declares, which node's parser holds the body to, so no bigger body is ever read: a
 * page's fetch of a string body always declares it.
 */
const readInvoke = async (request: IncomingMessage) => {
  const declared = Number(request.headers["content-length"]);
  if (!Number.isSafeInteger(declared) || declared > MAX_INVOKE_BYTES) {
    return null;
  }
  const body = await text(request);
  try {
    const parsed = invokeSchema.safeParse(parseJson(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const sendJson = (response: ServerResponse, status: number, body: JsonValue): void => {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const exitOf = (child: MainChild): string =>
  child.exitCode === null ? String(child.signalCode) : `code ${child.exitCode}`;

const isRunning = (child: MainChild): boolean =>
  child.exitCode === null && child.signalCode === null;

const linesOf = (stream: Readable) =>
  createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: stream });

export const startDevHost = async (options: DevHostOptions): Promise<DevHost> => {
  const { log } = options;
  const token = randomBytes(24).toString("base64url");
  const streams = new Set<ServerResponse>();
  const copied: string[] = [];
  const opened: Opening[] = [];
  // main's own ask to restart it, heard once the restart below exists
  const asks = new EventTarget();
  let main: Main | null = null;
  // a restart and a stop wait their turn, so main is never started twice over one save
  let turn: Promise<void> = Promise.resolve();
  let stopped = false;

  const broadcast = (channel: string, data: JsonValue): void => {
    const frame = `event: ${channel}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of streams) {
      stream.write(frame);
    }
  };

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
    peer.on("event", eventSchema, ({ channel, data }) => {
      broadcast(channel, data);
    });
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
      for (const stream of streams) {
        stream.end();
      }
      streams.clear();
      if (main !== null) {
        await stopMain(main);
        main = null;
      }
    });
  };

  const invoke = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!sameToken(bearer(request), token)) {
      sendJson(response, 401, { message: "the dev host's token is missing or wrong", ok: false });
      return;
    }
    const call = await readInvoke(request);
    if (call === null) {
      sendJson(response, 400, { message: "an invoke is {method, payload?}", ok: false });
      return;
    }
    if (main === null) {
      sendJson(response, 503, { message: "IdleBiz is still starting.", ok: false });
      return;
    }
    // a call with no payload carries none, as the shell relays it (commands.rs)
    const params: JsonValue =
      call.payload === undefined
        ? { method: call.method }
        : { method: call.method, payload: call.payload };
    try {
      sendJson(response, 200, await main.peer.request("invoke", params, jsonValueSchema));
    } catch (error) {
      sendJson(response, 503, { message: errorMessage(error), ok: false });
    }
  };

  const answerInvoke = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      await invoke(request, response);
    } catch (error) {
      sendJson(response, 500, { message: errorMessage(error), ok: false });
    }
  };

  const events = (url: URL, response: ServerResponse): void => {
    if (!sameToken(url.searchParams.get("token"), token)) {
      sendJson(response, 401, { message: "the dev host's token is missing or wrong", ok: false });
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    response.write(": main's events\n\n");
    streams.add(response);
    response.on("close", () => {
      streams.delete(response);
    });
  };

  const middleware: DevHost["middleware"] = (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === `${DEV_BRIDGE_PATH}/invoke` && request.method === "POST") {
      void answerInvoke(request, response);
      return;
    }
    if (url.pathname === `${DEV_BRIDGE_PATH}/events` && request.method === "GET") {
      events(url, response);
      return;
    }
    if (url.pathname.startsWith(`${DEV_BRIDGE_PATH}/`)) {
      sendJson(response, 404, { message: `the dev host answers no ${url.pathname}`, ok: false });
      return;
    }
    return next();
  };

  main = await startMain();
  return {
    copied,
    fragment: `bridge=${token}`,
    middleware,
    opened,
    restartMain,
    stop,
  };
};
