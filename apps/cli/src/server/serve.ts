import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { BodyLimitPlugin, RPCHandler } from "@orpc/server/node";
import { z } from "zod";
import { endAllAgents } from "@repo/agent-driver/acp-session";
import { RPC_PREFIX } from "@repo/contract/routes";
import { packageFile } from "../paths";
import { activityEvents } from "./activity";
import { writeAgentLauncher } from "./agent-launcher";
import { runnerPool } from "./agents/runner-pool";
import { logRunDenials } from "./agents/sandbox";
import { setAutopilot } from "./company-actions";
import { switchOffBeforeReset } from "./reset-links";
import { controlPlane } from "./control-plane";
import { deployToVercel } from "./deploy";
import { founderActions } from "./founder-actions";
import { askForInbox } from "./inbox-opening";
import { host, hostOver, launchSchema, setHost, trayClickSchema, windowSchema } from "./host";
import type { Handoff, Launch, WindowChange } from "./host";
import { keepAwake } from "./keep-awake";
import { broadcast } from "./lib/broadcast";
import { identityRefusal } from "./lib/founder-env";
import { suspendWrites } from "./lib/fs";
import { initLog } from "./lib/log";
import { guarded, report } from "./lib/report";
import { adoptShellPath } from "./lib/shell-path";
import { openedAtLogin } from "./login-item";
import { metricsPulse } from "./metrics-pulse";
import { createPageRouter } from "./page-router";
import { devPageOrigin, startPageServer } from "./page-server";
import type { PageServer, PageSource } from "./page-server";
import { launchRoot, openSave, rootDir, runBinDir } from "./paths";
import { readPrintFile } from "./print-listing";
import { printfulCatalog, printfulQuote } from "./printful";
import { stdioPeer } from "./relay/stdio";
import { claimSave } from "./save-claim";
import type { SaveClaim } from "./save-claim";
import { createScheduler } from "./scheduler";
import { clearVault, openVault } from "./vault/vault";
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
import { installFromMenu, startUpdateChecks, updateStatus } from "./updates";
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

const stopAgents = async () => {
  await scheduler.shutdown();
  await endAllAgents();
};

const resetGame = async () => {
  metricsPulse.stop();
  suspendWrites();

  try {
    const [, linksLeft] = await Promise.all([stopAgents(), switchOffBeforeReset()]);

    try {
      await clearVault();
    } catch (error) {
      report("reset vault", error);
    }

    await rm(rootDir(), { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });

    if (linksLeft) {
      await host().messageBox({
        detail: linksLeft,
        kind: "warning",
        message: "Some of the company's sales need you in Stripe or Printful",
      });
    }
  } finally {
    setImmediate(() => {
      host().relaunch();
    });
  }
};

const MARK_THROTTLE_MS = 60_000;
let markedAt = 0;

const markSeen = (throttled: boolean) => {
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

const windowChanged = ({ state }: WindowChange) => {
  if (state !== "shown") {
    markSeen(state === "blurred");
  }

  if (state === "hidden" || state === "shown") {
    appTray.setWindowless(state === "hidden");
  }
};

let booting: Promise<void> | null = null;

const bootSettled = async () => {
  await booting?.catch(() => null);
};

let claim: SaveClaim | null = null;

let page: PageServer | null = null;

let quitting: Promise<void> | null = null;

const quit = async () => {
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

const quitAndExit = () => {
  void (async () => {
    await quit();
    process.exit(0);
  })();
};

const peer = stdioPeer(quitAndExit);

for (const signal of ["SIGTERM", "SIGINT"] satisfies NodeJS.Signals[]) {
  process.once(signal, quitAndExit);
}

const pageSourceOf = (launch: Launch) => {
  if (launch.pageDevUrl === null) {
    const dir = packageFile("dist/page");

    if (!existsSync(path.join(dir, "index.html"))) {
      throw new Error(`the window's page is not built: ${dir} holds no index.html`);
    }

    return { dir, kind: "built" } satisfies PageSource;
  }

  if (launch.packaged) {
    throw new Error("a packaged IdleBiz serves only the page it ships");
  }

  return { kind: "dev", origin: devPageOrigin(launch.pageDevUrl) } satisfies PageSource;
};

const boot = async (launch: Launch) => {
  setHost(hostOver(peer), launch);

  if (launch.packaged) {
    const refused = identityRefusal(homedir(), process.env.SHELL, userInfo());

    if (refused !== null) {
      throw new Error(refused);
    }
  }

  claim = await claimSave(rootDir(), homedir());
  const vaultProblem = openVault(launch, host());
  store.initStore();

  if (vaultProblem) {
    store.noteUnreadable("secrets", vaultProblem.where, vaultProblem.cause);
  }

  runnerPool.init(adoptShellPath(launch.packaged));
  logRunDenials();
  writeAgentLauncher(runBinDir(), process.execPath, packageFile("dist/index.js"));
  await controlPlane.start();

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

    if (e.kind === "run.end" && e.payload.settled === "blocked") {
      guarded("standing sign-off", () => founder.answerStanding());
    }
  });
  scheduler.start();
  guarded("standing sign-off", () => founder.answerStanding());

  metricsPulse.start();

  appTray.start();

  if (openedAtLogin()) {
    appTray.startWindowless();
  }

  startUpdateChecks(() => {
    appTray.refresh();
    broadcast("update", updateStatus());
  });

  void (async () => {
    await runnerPool.sandboxRefusal();
    guarded("drain queue", () => scheduler.tick());
  })();
};

peer.handle("hello", launchSchema, async (launch) => {
  try {
    booting = boot(launch);
    await booting;
  } catch (error) {
    report("boot", error);
    throw error;
  }

  return null;
});

peer.handle("handoff", z.null(), () => {
  if (page === null) {
    throw new Error("IdleBiz is still starting.");
  }

  const { handoffUrl, origin } = page.handoff();

  return { handoffUrl, origin } satisfies Handoff;
});

peer.handle("quit", z.null(), async () => {
  await quit();

  return null;
});

peer.on("window", windowSchema, windowChanged);

peer.on("tray", trayClickSchema, ({ on }) => {
  if (store.getCompany()) {
    guarded("tray autopilot", () => setAutopilot(on));
  }
});

peer.on("inbox", z.null(), () => {
  askForInbox();
  broadcast("opening", null);
});

peer.on("update", z.null(), () => {
  void installFromMenu();
});
