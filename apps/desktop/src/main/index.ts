import { createHash } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  powerSaveBlocker,
  safeStorage,
  session,
  shell,
} from "electron";
import { registerIpcHandlers } from "@/main/lib/ipc-handler";
import type { IpcHandlers } from "@/main/lib/ipc-handler";
import { broadcast } from "@/main/lib/broadcast";
import { suspendWrites } from "@/main/lib/fs";
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
} from "@/main/vercel-connect";
import { adoptShellPath } from "@/main/lib/shell-path";
import { bootFailed, initLog } from "@/main/lib/log";
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

const moduleDir = import.meta.dirname;
const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;

const scheduler = createScheduler(agentDriver, keepAwake(powerSaveBlocker));

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
      await dialog.showMessageBox({
        detail: stripeLeft,
        message: "Stripe did not confirm it revoked IdleBiz's access",
        type: "warning",
      });
    }
    if (linksLeft) {
      await dialog.showMessageBox({
        detail: linksLeft,
        message: "Some of the company's sales need you in Stripe or Printful",
        type: "warning",
      });
    }
  } finally {
    setImmediate(() => {
      app.relaunch();
      app.exit(0);
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
  // the renderer is refused every permission, the clipboard's included
  copyText: ({ text }) => clipboard.writeText(text),
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
    const err = await shell.openPath(ROOT_DIR);
    if (err) {
      throw new Error(err);
    }
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
} satisfies IpcHandlers;

const appUrl = (): string => {
  const dev = isDev ? process.env.ELECTRON_RENDERER_URL : undefined;
  return dev ?? pathToFileURL(path.join(moduleDir, "../renderer/index.html")).toString();
};

const isWebUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
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

const createWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    backgroundColor: "#12141c",
    height: 800,
    show: false,
    title: "IdleBiz",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(moduleDir, "../preload/index.js"),
      sandbox: true,
      webSecurity: true,
    },
    width: 1280,
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  // the window shows this app and nothing else: a dropped file, a link, an
  // agent-written page would otherwise navigate the renderer — bridge intact
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== appUrl()) {
      event.preventDefault();
    }
  });

  win.once("ready-to-show", () => win.show());

  void win.loadURL(appUrl());
  if (isDev) {
    win.webContents.openDevTools({ mode: "detach" });
  }

  win.on("blur", () => markSeen(true));
  win.on("hide", () => markSeen(false));
  win.on("minimize", () => markSeen(false));
  win.on("close", () => markSeen(false));

  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
    // Keep the background office accessible through the tray.
    if (BrowserWindow.getAllWindows().length === 0) {
      app.dock?.hide();
      appTray.setWindowless(true);
    }
  });
  return win;
};

const ensureWindow = (): void => {
  void app.dock?.show();
  appTray.setWindowless(false);
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = createWindow();
};

// Electron names the app, and so its userData, after package.json's productName;
// dev gets its own so a dev run never shares a lock or a cache with the app. The
// single-instance lock lives in userData and guards a save, so each isolated save
// root gets its own beneath it: sessions on different roots run side by side.
// Dev's Electron is ad-hoc signed, so the Keychain asks again for its item after every
// Electron change, and that prompt stalls automation: dev seals with Chromium's mock
// keychain, a fixed key, and never touches the real one.
if (isDev) {
  const devData = path.join(app.getPath("appData"), `${app.name} (dev)`);
  const rootId = createHash("sha256").update(ROOT_DIR).digest("hex").slice(0, 16);
  app.setPath("userData", ON_REAL_SAVE ? devData : path.join(devData, "roots", rootId));
  app.commandLine.appendSwitch("use-mock-keychain");
}
initLog();

// one office per save: a second instance would run a second scheduler
// against the same save, spending twice and racing every write
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", ensureWindow);

const boot = async (): Promise<void> => {
  await app.whenReady();
  // the renderer asks for nothing a game needs: no camera, mic, location, notifications
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Electron callback API
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Electron callback API
    callback(false);
  });
  // The app can't open what the mock key seals, so on the real save dev seals nothing:
  // a key dev entered or found plain stays plain for the app to seal, never stranded.
  if (isDev && ON_REAL_SAVE) {
    report("secrets", "dev on the real save keeps secrets.json's keys as it finds them");
  } else if (safeStorage.isEncryptionAvailable()) {
    setSealer({
      open: (sealed) => safeStorage.decryptString(sealed),
      seal: (plain) => safeStorage.encryptString(plain),
    });
  } else {
    report("secrets", "the Keychain is unavailable, so secrets.json keeps its keys as plain text");
  }
  store.initStore();
  const unreadableSecrets = checkSecrets();
  if (unreadableSecrets) {
    store.noteUnreadable("secrets", unreadableSecrets.file, unreadableSecrets.cause);
  }
  await adoptShellPath();
  agentDriver.init();
  await controlPlane.start();
  registerIpcHandlers(ipcHandlers);

  activityEvents.on("activity", (e) => broadcast("onActivity", e));
  scheduler.start();

  metricsPulse.start();

  initStripeConnect({
    notify: (status) => broadcast("onStripeStatus", status),
    // a Stripe connection only reads revenue: work waiting on a key to charge with waits on
    onConnected: () => stripeReady("stripe"),
    openExternal: (url) => shell.openExternal(url),
  });
  initVercelConnect({
    onConnected: (productId) => {
      metricsPulse.now();
      scheduler.resumeVercelAsks(productId);
    },
  });

  appTray.init({
    openWindow: ensureWindow,
    setAutopilot: (on) => {
      if (store.getCompany()) {
        guarded("tray autopilot", () => setAutopilot(on));
      }
    },
  });

  if (openedAtLogin()) {
    app.dock?.hide();
    appTray.startWindowless();
  } else {
    mainWindow = createWindow();
  }

  app.on("activate", ensureWindow);

  // the queue waits on the seal's check: drain it the moment that settles, not a tick later
  await agentDriver.sealRefusal();
  guarded("drain queue", () => scheduler.tick());
};

void (async () => {
  try {
    await boot();
  } catch (error) {
    bootFailed(error);
  }
})();

app.on("window-all-closed", () => {
  // macOS: stay resident — the tray owns the lifecycle; Quit lives in its menu
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let quitStage: "running" | "stopping agents" | "agents stopped" = "running";
app.on("before-quit", (event) => {
  if (quitStage === "agents stopped") {
    return;
  }
  event.preventDefault();
  if (quitStage === "stopping agents") {
    return;
  }
  quitStage = "stopping agents";
  metricsPulse.stop();
  void (async () => {
    try {
      await stopAgents();
      controlPlane.stop();
    } finally {
      quitStage = "agents stopped";
      app.quit();
    }
  })();
});
