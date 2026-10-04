// Main: the one process that owns the save, the keys and the runs. It runs as the desktop shell's
// node child (or the dev host's), and speaks to the window only through it, over its stdio
// (`relay/stdio.ts`): no port carries the founder's approve button. The shell says hello with the
// facts of this launch, and main boots; it invokes main's IPC methods for the window, and main asks
// it for what only a native app does (`host.ts`). Stdin's end is the shell going away.

import { rm } from "node:fs/promises";
import { z } from "zod";
import { host, hostOver, launchSchema, setHost } from "@/main/host";
import type { Launch } from "@/main/host";
import { ipcDispatcher } from "@/main/lib/ipc-handler";
import type { IpcDispatch, IpcHandlers } from "@/main/lib/ipc-handler";
import { broadcast, setEventSink } from "@/main/lib/broadcast";
import { suspendWrites } from "@/main/lib/fs";
import { osCryptSealer } from "@/main/lib/os-crypt";
import { stdioPeer } from "@/main/relay/stdio";
import * as store from "@/main/store/store";
import { activityEvents } from "@/main/activity";
import { agentDriver } from "@/main/agents/agent-driver";
import { notingSeal } from "@/main/agents/seal";
import { endAllAgents } from "@repo/agent-driver/acp-session";
import { controlPlane } from "@/main/control-plane";
import { openProduct, openWorkspacePath, productStatus } from "@/main/product";
import { chatOptions } from "@/main/prompts/chat-options";
import {
  haltForBudget,
  killBet,
  retireProduct,
  setAutopilot,
  startProduct,
  switchOffBeforeReset,
} from "@/main/company-actions";
import { keepAwake } from "@/main/keep-awake";
import { launchAtLogin, openedAtLogin, setLaunchAtLogin } from "@/main/login-item";
import { createScheduler } from "@/main/scheduler";
import { appTray } from "@/main/tray";
import { startLogin, generateCandidates } from "@/main/agents/onboarding";
import { metricsPulse } from "@/main/metrics-pulse";
import {
  connectVercel,
  disconnectVercel,
  initVercelConnect,
  listVercelProjects,
  saveVercelToken,
} from "@/main/vercel-connect";
import { adoptShellPath } from "@/main/lib/shell-path";
import { initLog } from "@/main/lib/log";
import { guarded, report } from "@/main/lib/report";
import { checkSecrets, setSealer } from "@/main/secrets";
import {
  initStripeConnect,
  beginConnect,
  disconnectStripe,
  getStripeStatus,
  revokeBeforeReset,
} from "@/main/stripe-connect";
import { removeStripeKey, saveStripeKey, stripeKeyStatus } from "@/main/stripe-key";
import { printfulTokenStatus, removePrintfulToken, savePrintfulToken } from "@/main/printful-token";
import { ON_REAL_SAVE, ROOT_DIR } from "@/main/paths";
import { isOutOfBudget, spriteSeedFor } from "@/shared/domain";
import type { IntegrationNeed } from "@/shared/domain";
import { jsonValueSchema } from "@/shared/json";

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

const ipcHandlers = {
  answerQuestion: ({ taskId, answer }) => scheduler.answerQuestion(taskId, answer),
  assignTask: ({ taskId, employeeId }) => scheduler.assign(taskId, employeeId),
  composeCharacter: async ({ seed }) => {
    const { composeCharacter } = await import("@/main/character/compositor");
    return await composeCharacter(seed);
  },
  // the window is refused every permission, the clipboard's included: the shell writes it
  copyText: async ({ text }) => {
    await host().copyText(text);
  },
  createProduct: (input) => startProduct(input, null),
  directEmployee: ({ employeeId, instruction }) =>
    scheduler.directEmployee(employeeId, instruction.trim()),
  employeeOptions: ({ employeeId }) => {
    const emp = store.getEmployee(employeeId);
    if (!emp) {
      throw new Error(`no employee ${employeeId}`);
    }
    return chatOptions(emp, store.openTasksFor(employeeId));
  },
  // one call, whole or not at all: the roster's CLIs are chosen first, so a
  // machine with nothing signed in fails before a folder exists
  foundCompany: ({ hires, ...company }) =>
    store.foundCompany({
      ...company,
      hires: hires.map((hire, i) => ({ runner: agentDriver.pickRunner(i), ...hire })),
    }),
  generateHires: async ({ companyName, mission, businessType }) => {
    const candidates = await generateCandidates({ businessType, companyName, mission });
    return candidates.map((candidate, i) =>
      Object.assign(candidate, {
        spriteSeed: spriteSeedFor(candidate.role, candidate.name, `-${i}`),
      }),
    );
  },
  getCompany: store.getCompany,
  getFounderChoices: async () => {
    const { listFounderChoices } = await import("@/main/character/compositor");
    return await listFounderChoices(6);
  },
  hasAuth: async () => ({
    ok: await agentDriver.hasAnyRunner(),
    signedOut: await agentDriver.signedOut(),
  }),
  killBet: ({ betId, reason }) => killBet(betId, reason),
  killProduct: ({ productId, reason }) => retireProduct(productId, reason, null),
  launchAtLogin,
  listBets: store.listBets,
  listEmployees: store.listEmployees,
  listProducts: store.listProducts,
  listTasks: store.queryTasks,
  // the first report waits on the seal's check, so a refusal is in it
  loadReport: async () => {
    const refusal = await agentDriver.sealRefusal();
    return notingSeal(store.loadReport(), refusal);
  },
  openCompanyPath: ({ rel }) => openWorkspacePath(rel),
  openProduct: async ({ productId }) => ({ opened: await openProduct(productId) }),
  openSaveFolder: async () => {
    await host().open({ kind: "path", target: ROOT_DIR });
  },
  postTeamChat: ({ text }) => scheduler.founderMessage(text.trim()),
  printfulTokenRemove: removePrintfulToken,
  printfulTokenSave: async ({ token }) => {
    await savePrintfulToken(token);
    scheduler.resumeIntegrationAsks("printful");
  },
  printfulTokenStatus,
  productStatus: ({ productId }) => productStatus(productId),
  resetGame,
  resetSpend: store.resetSpend,
  resolveAction: ({ taskId, reply }) => scheduler.resolveAction(taskId, reply),
  resolveApproval: ({ taskId, approved }) => scheduler.resolveApproval(taskId, approved),
  restingRunners: () => agentDriver.restingRunners(),
  setAutopilot: ({ running }) => setAutopilot(running),
  setBudget: ({ budget }) => {
    const company = store.setBudget(budget);
    if (isOutOfBudget(company)) {
      haltForBudget(company);
    }
    return store.requireCompany();
  },
  setLaunchAtLogin: ({ on }) => setLaunchAtLogin(on),
  setMaxAgents: ({ maxAgents }) => store.setMaxAgents(maxAgents),
  shippingLog: store.shippingLog,
  startLogin: () => {
    void startLogin(agentDriver, (e) => broadcast("onAuthEvent", e));
    return { started: true };
  },
  stripeConnect: () => beginConnect(store.requireCompany().id),
  stripeDisconnect: () => disconnectStripe(store.requireCompany().id),
  stripeKeyRemove: () => {
    removeStripeKey();
    metricsPulse.now();
  },
  stripeKeySave: async ({ key }) => {
    await saveStripeKey(key);
    stripeReady("stripe", "stripe-key");
  },
  stripeKeyStatus,
  stripeStatus: () => {
    const company = store.getCompany();
    return company ? getStripeStatus(company.id) : { state: "disconnected" };
  },
  takeDigest: store.takeDigest,
  teamMessages: ({ limit }) => store.recentTeamMessages(limit ?? 30),
  vercelConnect: connectVercel,
  vercelDisconnect: ({ productId }) => disconnectVercel(productId),
  vercelListProjects: ({ token }) => listVercelProjects(token),
  vercelSaveToken: saveVercelToken,
} satisfies IpcHandlers;

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

let dispatch: IpcDispatch | null = null;

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
  await controlPlane.start();
  setEventSink((channel, data) => {
    peer.notify("event", { channel, data });
  });
  dispatch = ipcDispatcher(ipcHandlers);

  activityEvents.on("activity", (e) => broadcast("onActivity", e));
  scheduler.start();

  metricsPulse.start();

  initStripeConnect({
    notify: (status) => broadcast("onStripeStatus", status),
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

peer.handle(
  "invoke",
  z.object({ method: z.string(), payload: jsonValueSchema.optional() }),
  async ({ method, payload }) =>
    dispatch === null
      ? { message: "IdleBiz is still starting.", ok: false }
      : await dispatch(method, payload),
);

// the shell closes main's stdin once this answers, and main exits then
peer.handle("quit", z.null(), async () => {
  await quit();
  return null;
});

peer.on("window", windowSchema, windowChanged);

peer.on("tray", z.object({ on: z.boolean() }), ({ on }) => {
  appTray.setAutopilot(on);
});
