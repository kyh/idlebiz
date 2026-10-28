// Main, the server `idlebiz serve` runs, as docs/app.md's "The page, the shell and main" describes.
// Importing this module boots it, so commands/serve.ts loads it for `serve` alone.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/node";
import { z } from "zod";
import { endAllAgents } from "@repo/agent-driver/acp-session";
import { RPC_PREFIX } from "@repo/contract/routes";
import { packageFile } from "../paths";
import { activityEvents } from "./activity";
import { writeAgentLauncher } from "./agent-launcher";
import { runnerPool } from "./agents/runner-pool";
import { setAutopilot } from "./company-actions";
import { switchOffBeforeReset } from "./reset-links";
import { controlPlane } from "./control-plane";
import { deployToVercel } from "./deploy";
import { founderActions } from "./founder-actions";
import { host, hostOver, launchSchema, setHost, trayClickSchema, windowSchema } from "./host";
import type { Handoff, Launch, WindowChange } from "./host";
import { keepAwake } from "./keep-awake";
import { broadcast } from "./lib/broadcast";
import { suspendWrites } from "./lib/fs";
import { initLog } from "./lib/log";
import { guarded, report } from "./lib/report";
import { adoptShellPath } from "./lib/shell-path";
import { openedAtLogin } from "./login-item";
import { metricsPulse } from "./metrics-pulse";
import { createPageRouter } from "./page-router";
import { devPageOrigin, startPageServer } from "./page-server";
import type { PageServer, PageSource } from "./page-server";
import { launchRoot, onRealSave, openSave, rootDir, runBinDir } from "./paths";
import { readPrintFile } from "./print-listing";
import { printfulCatalog, printfulQuote } from "./printful";
import { stdioPeer } from "./relay/stdio";
import { claimSave } from "./save-claim";
import type { SaveClaim } from "./save-claim";
import { createScheduler } from "./scheduler";
import { DEV_SECRETS_KEY, checkSecrets, sealerFor, setSealer } from "./secrets";
import * as store from "./store/store";
import {
  stripeCheckoutAccess,
  stripeLinkAccess,
  stripeListingAccess,
  stripePaymentLink,
  stripeShippedLink,
} from "./stripe-links";
import type { Integrations } from "./tools/define";
import { appTray } from "./tray";
import { productionHosts, validateToken } from "./vercel";
import { setVercelEnv } from "./vercel-env";

initLog();
openSave(launchRoot(process.env));

const integrations: Integrations = {
  checkVercelToken: validateToken,
  checkoutAccess: stripeCheckoutAccess,
  createPaymentLink: stripePaymentLink,
  createPrintLink: stripeShippedLink,
  deploy: deployToVercel,
  linkAccess: stripeLinkAccess,
  listingAccess: stripeListingAccess,
  printCatalog: printfulCatalog,
  productionHosts,
  quotePrint: printfulQuote,
  readPrintFile,
  setEnv: setVercelEnv,
};

const scheduler = createScheduler(
  runnerPool,
  keepAwake((on) => {
    host().keepAwake(on);
  }),
  integrations,
);

const founder = founderActions(scheduler);

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
    const [, linksLeft] = await Promise.all([stopAgents(), switchOffBeforeReset()]);
    await rm(rootDir(), { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });
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

const windowChanged = ({ state }: WindowChange): void => {
  // leaving the office (a blur, a hide, a minimize) marks it seen; coming back must not, or the
  // next digest would start at the return and miss what happened while away
  if (state !== "shown") {
    markSeen(state === "blurred");
  }
  if (state === "hidden" || state === "shown") {
    appTray.setWindowless(state === "hidden");
  }
};

// The app can't open what dev's key seals, so on the real save dev seals nothing:
// a key dev entered or found plain stays plain for the app to seal, never stranded.
const sealSecrets = (launch: Launch): void => {
  if (!launch.packaged && onRealSave()) {
    report("secrets", "dev on the real save keeps secrets.json's keys as it finds them");
  } else if (!launch.packaged) {
    setSealer(sealerFor(DEV_SECRETS_KEY));
  } else if (launch.sealingKey === null) {
    report("secrets", "the Keychain is unavailable, so secrets.json keeps its keys as plain text");
  } else {
    setSealer(sealerFor(launch.sealingKey));
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

// this main's hold on the save, from the boot's first step: a boot refused it holds none to let go
let claim: SaveClaim | null = null;

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
      claim?.release();
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
  claim = await claimSave(rootDir(), homedir());
  sealSecrets(launch);
  store.initStore();
  const unreadableSecrets = checkSecrets();
  if (unreadableSecrets) {
    store.noteUnreadable("secrets", unreadableSecrets.file, unreadableSecrets.cause);
  }
  // the runs' seal and the look for their CLIs read PATH, so they wait for the login shell's;
  // the window does not
  runnerPool.init(adoptShellPath(launch.packaged));
  // the command the runs call the company's tools with: this node, on the CLI it was started from
  writeAgentLauncher(runBinDir(), process.execPath, packageFile("dist/index.js"));
  await controlPlane.start();
  // the largest call a page makes: a pasted key, a long answer to a question
  const rpc = new RPCHandler(createPageRouter({ founder, resetGame }), {
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

  activityEvents.on("activity", (e) => {
    broadcast("activity", e);
  });
  scheduler.start();

  metricsPulse.start();

  appTray.start();
  if (openedAtLogin()) {
    appTray.startWindowless();
  }

  // the queue waits on the seal's check: drain it the moment that settles, not a tick later
  void (async () => {
    await runnerPool.sealRefusal();
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
  return { handoffUrl, origin } satisfies Handoff;
});

// the shell closes main's stdin once this answers, and main exits then
peer.handle("quit", z.null(), async () => {
  await quit();
  return null;
});

peer.on("window", windowSchema, windowChanged);

// the menu's autopilot item sets what its label said, whatever has moved since
peer.on("tray", trayClickSchema, ({ on }) => {
  if (store.getCompany()) {
    guarded("tray autopilot", () => setAutopilot(on));
  }
});
