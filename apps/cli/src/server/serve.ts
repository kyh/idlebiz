// Main, the server `idlebiz serve` runs: the one process that owns the save, the keys and the runs.
// It runs as the desktop shell's node child (or the dev host's), which speaks to it over its stdio
// (`relay/stdio.ts`), and its first import is its boot (commands/serve.ts loads it for `serve`
// alone). The shell says hello with the facts of this launch, and main boots; main asks it for
// what only a native app does (`host.ts`), and it asks main for a handoff into the window's page.
// Main serves that page itself, and answers its calls and sends it its events on the page's own
// origin (`page-server.ts`), whose port the seal closes to every employee run. The runs reach the
// company through the control plane instead (`control-plane.ts`), with the `idlebiz` command main
// writes them at boot (`agent-launcher.ts`). Stdin's end is the shell going away.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/node";
import { z } from "zod";
import { endAllAgents } from "@repo/agent-driver/acp-session";
import { RPC_PREFIX } from "@repo/contract/routes";
import type { IntegrationNeed } from "@repo/domain/domain";
import { packageFile } from "../paths";
import { activityEvents } from "./activity";
import { writeAgentLauncher } from "./agent-launcher";
import { agentDriver } from "./agents/agent-driver";
import { setAutopilot, switchOffBeforeReset } from "./company-actions";
import { controlPlane } from "./control-plane";
import { host, hostOver, launchSchema, setHost } from "./host";
import type { Launch } from "./host";
import { keepAwake } from "./keep-awake";
import { broadcast, setEventSink } from "./lib/broadcast";
import { suspendWrites } from "./lib/fs";
import { initLog } from "./lib/log";
import { osCryptSealer } from "./lib/os-crypt";
import { guarded, report } from "./lib/report";
import { adoptShellPath } from "./lib/shell-path";
import { openedAtLogin } from "./login-item";
import { metricsPulse } from "./metrics-pulse";
import { createPageRouter } from "./page-router";
import { devPageOrigin, startPageServer } from "./page-server";
import type { PageServer, PageSource } from "./page-server";
import { ON_REAL_SAVE, ROOT_DIR, RUN_BIN_DIR } from "./paths";
import { stdioPeer } from "./relay/stdio";
import { createScheduler } from "./scheduler";
import { checkSecrets, setSealer } from "./secrets";
import * as store from "./store/store";
import { initStripeConnect, revokeBeforeReset } from "./stripe-connect";
import { appTray } from "./tray";
import { initVercelConnect } from "./vercel-connect";

initLog();

// the shell's power assertion: one at a time, since keepAwake starts at most one
const scheduler = createScheduler(
  agentDriver,
  keepAwake({
    start: () => {
      host().keepAwake(true);
      return 1;
    },
    stop: () => {
      host().keepAwake(false);
    },
  }),
);

// An ended turn's agent is left to shut down, with a timer to kill its process group if it
// does not; that timer never fires once the app exits, so every exit waits the agents out.
const stopAgents = async (): Promise<void> => {
  await scheduler.shutdown();
  await endAllAgents();
};

// Suspend writes before aborting runs so their completion cannot resurrect the save.
// The agents' own detached tools may still be writing, hence the retries. Relaunch even
// if the delete fails: writes never resume, and boot reports what is left of the save.
const resetGame = async (): Promise<void> => {
  metricsPulse.stop();
  suspendWrites();
  try {
    const [, stripeLeft, linksLeft] = await Promise.all([
      stopAgents(),
      revokeBeforeReset(),
      switchOffBeforeReset(),
    ]);
    await rm(ROOT_DIR, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });
    if (stripeLeft) {
      await host().messageBox({
        detail: stripeLeft,
        kind: "warning",
        message: "Stripe did not confirm it revoked IdleBiz's access",
      });
    }
    if (linksLeft) {
      await host().messageBox({
        detail: linksLeft,
        kind: "warning",
        message: "Some of the company's sales need you in Stripe or Printful",
      });
    }
  } finally {
    // after this reply has gone: the shell restarts the app, which ends this main
    setImmediate(() => {
      host().relaunch();
    });
  }
};

/** Stripe reads revenue now: read it at once, and resume the work that waited on it. */
const stripeReady = (...needs: IntegrationNeed[]): void => {
  metricsPulse.now();
  scheduler.resumeIntegrationAsks(...needs);
};

/** "Seen" is the last moment the founder had the office in front of them; the
 *  next digest starts there. Focus comes and goes many times a minute, so a
 *  blur only writes once a minute; leaving the screen always does. */
const MARK_THROTTLE_MS = 60_000;
let markedAt = 0;
const markSeen = (throttled: boolean): void => {
  const now = Date.now();
  if (throttled && now - markedAt < MARK_THROTTLE_MS) {
    return;
  }
  const company = store.getCompany();
  if (company) {
    store.markSeen(now);
    markedAt = now;
  }
};

// what the shell says of its one window: blurred, minimized, hidden (closing it hides it: the
// office lives on in the menu bar, and the dock goes with it), or shown again
const windowSchema = z.object({ state: z.enum(["blurred", "minimized", "hidden", "shown"]) });

const windowChanged = ({ state }: z.infer<typeof windowSchema>): void => {
  // leaving the office marks it seen, as the Electron window's blur, hide and minimize did; coming
  // back must not, or the next digest would start at the return and miss what happened while away
  if (state !== "shown") {
    markSeen(state === "blurred");
  }
  if (state === "hidden" || state === "shown") {
    appTray.setWindowless(state === "hidden");
  }
};

// The app can't open what the mock key seals, so on the real save dev seals nothing:
// a key dev entered or found plain stays plain for the app to seal, never stranded.
const sealSecrets = (launch: Launch): void => {
  if (!launch.packaged && ON_REAL_SAVE) {
    report("secrets", "dev on the real save keeps secrets.json's keys as it finds them");
  } else if (launch.safeStoragePassword === null) {
    report("secrets", "the Keychain is unavailable, so secrets.json keeps its keys as plain text");
  } else {
    setSealer(osCryptSealer(launch.safeStoragePassword));
  }
};

// the boot hello started, until it settles: a quit asked mid-boot waits it out, since what the boot
// starts after the quit stopped everything (the scheduler, the control plane) would outlive it
let booting: Promise<void> | null = null;

const bootSettled = async (): Promise<void> => {
  try {
    await booting;
  } catch {
    // a failed boot was reported to the shell, which says so and quits
  }
};

// the window's page and main's door for it, once the boot has started it
let page: PageServer | null = null;

// Every exit waits the agents out, and runs once however many ways it is asked for: the
// shell's Quit, the shell going away, a relaunch.
let quitting: Promise<void> | null = null;
const quit = async (): Promise<void> => {
  quitting ??= (async () => {
    await bootSettled();
    metricsPulse.stop();
    try {
      await stopAgents();
    } finally {
      controlPlane.stop();
      await page?.stop();
    }
  })();
  await quitting;
};

const quitAndExit = (): void => {
  void (async () => {
    await quit();
    process.exit(0);
  })();
};

const peer = stdioPeer(quitAndExit);

// A TERM or an INT stops the runs first, as Quit does: devkill's, a `kill`'s, launchd's at
// shutdown. The terminal's Ctrl-C never reaches main, which leads its own process group.
for (const signal of ["SIGTERM", "SIGINT"] satisfies NodeJS.Signals[]) {
  process.once(signal, quitAndExit);
}

// where the page's files come from: the build this package stages beside its bundle (`dist/page`),
// or under a development shell Vite
const pageSourceOf = (launch: Launch): PageSource => {
  if (launch.pageDevUrl === null) {
    const dir = packageFile("dist/page");
    if (!existsSync(path.join(dir, "index.html"))) {
      throw new Error(`the window's page is not built: ${dir} holds no index.html`);
    }
    return { dir, kind: "built" };
  }
  if (launch.packaged) {
    throw new Error("a packaged IdleBiz serves only the page it ships");
  }
  return { kind: "dev", origin: devPageOrigin(launch.pageDevUrl) };
};

const boot = async (launch: Launch): Promise<void> => {
  setHost(hostOver(peer), launch);
  sealSecrets(launch);
  store.initStore();
  const unreadableSecrets = checkSecrets();
  if (unreadableSecrets) {
    store.noteUnreadable("secrets", unreadableSecrets.file, unreadableSecrets.cause);
  }
  await adoptShellPath();
  agentDriver.init();
  // the command the runs call the company's tools with: this node, on the CLI it was started from
  writeAgentLauncher(RUN_BIN_DIR, process.execPath, packageFile("dist/index.js"));
  await controlPlane.start();
  // the largest call a page makes: a pasted key, a long answer to a question
  const rpc = new RPCHandler(createPageRouter({ resetGame, scheduler, stripeReady }), {
    plugins: [new BodyLimitPlugin({ maxBodySize: 1024 * 1024 })],
  });
  const served = await startPageServer({
    handleRpc: async (request, response) => {
      const { matched } = await rpc.handle(request, response, { context: {}, prefix: RPC_PREFIX });
      return matched;
    },
    page: pageSourceOf(launch),
  });
  page = served;
  setEventSink(served.broadcast);

  activityEvents.on("activity", (e) => {
    broadcast("activity", e);
  });
  scheduler.start();

  metricsPulse.start();

  initStripeConnect({
    notify: (status) => {
      broadcast("stripe", status);
    },
    // a Stripe connection only reads revenue: work waiting on a key to charge with waits on
    onConnected: () => stripeReady("stripe"),
    openExternal: async (url) => {
      await host().open({ kind: "url", target: url });
    },
  });
  initVercelConnect({
    onConnected: (connection) => {
      metricsPulse.now();
      scheduler.resumeVercelAsks(connection);
    },
  });

  appTray.init({
    setAutopilot: (on) => {
      if (store.getCompany()) {
        guarded("tray autopilot", () => setAutopilot(on));
      }
    },
  });
  if (openedAtLogin()) {
    appTray.startWindowless();
  }

  // the queue waits on the seal's check: drain it the moment that settles, not a tick later
  void (async () => {
    await agentDriver.sealRefusal();
    guarded("drain queue", () => scheduler.tick());
  })();
};

peer.handle("hello", launchSchema, async (launch) => {
  try {
    booting = boot(launch);
    await booting;
  } catch (error) {
    // the shell says it in a box, with where the log is, and quits; main goes when stdin closes
    report("boot", error);
    throw error;
  }
  return null;
});

// a one-time link into the window's page, which the shell opens its window on: asked for each
// window it makes, since a link left unused for five minutes signs nothing in
peer.handle("handoff", z.null(), () => {
  if (page === null) {
    throw new Error("IdleBiz is still starting.");
  }
  const { handoffUrl, origin } = page.handoff();
  return { handoffUrl, origin };
});

// the shell closes main's stdin once this answers, and main exits then
peer.handle("quit", z.null(), async () => {
  await quit();
  return null;
});

peer.on("window", windowSchema, windowChanged);

peer.on("tray", z.object({ on: z.boolean() }), ({ on }) => {
  appTray.setAutopilot(on);
});
