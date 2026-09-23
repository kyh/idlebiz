import path from "node:path";
import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, session, shell } from "electron";
import { handle } from "@/main/lib/ipc-handler";
import { broadcast } from "@/main/lib/broadcast";
import { suspendWrites } from "@/main/lib/fs";
import * as store from "@/main/store/store";
import { activityEvents } from "@/main/activity";
import { agentDriver } from "@/main/agents/agent-driver";
import { controlPlane } from "@/main/control-plane";
import { loadOfficeDesign, saveOfficeDesign } from "@/main/office-design";
import { openProduct, openWorkspacePath, productStatus } from "@/main/product";
import { chatOptions } from "@/main/prompts/chat-options";
import {
  haltForBudget,
  killBet,
  retireProduct,
  setAutopilot,
  startProduct,
} from "@/main/company-actions";
import { scheduler } from "@/main/scheduler";
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
import { exportSecretsToEnv } from "@/main/secrets";
import {
  initStripeConnect,
  beginConnect,
  disconnectStripe,
  getStripeStatus,
} from "@/main/stripe-connect";
import { ROOT_DIR } from "@/main/paths";
import { isOutOfBudget, spriteSeedFor } from "@/shared/domain";

const moduleDir = import.meta.dirname;
const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;

// Suspend writes before aborting runs so their completion cannot resurrect the save.
// Aborted children may still be writing, hence the retries. Relaunch even if the
// delete fails: writes never resume, and boot reports what is left of the save.
const resetGame = async (): Promise<void> => {
  metricsPulse.stop();
  suspendWrites();
  scheduler.shutdown();
  try {
    await rm(ROOT_DIR, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });
  } finally {
    setImmediate(() => {
      app.relaunch();
      app.exit(0);
    });
  }
};

const registerIpcHandlers = (): void => {
  handle("hasAuth", async () => ({ ok: await agentDriver.hasAnyRunner() }));

  handle("startLogin", () => {
    void startLogin((e) => broadcast("onAuthEvent", e));
    return { started: true };
  });

  handle("composeCharacter", async ({ seed }) => {
    const { composeCharacter } = await import("@/main/character/compositor");
    return composeCharacter(seed);
  });

  handle("getFounderChoices", async () => {
    const { listFounderChoices } = await import("@/main/character/compositor");
    return listFounderChoices(6);
  });

  handle("generateHires", async ({ companyName, mission, businessType }) => {
    const candidates = await generateCandidates({ businessType, companyName, mission });
    return candidates.map((candidate, i) =>
      Object.assign(candidate, {
        spriteSeed: spriteSeedFor(candidate.role, candidate.name, `-${i}`),
      }),
    );
  });

  // one call, whole or not at all: the roster's CLIs are chosen first, so a
  // machine with nothing signed in fails before a folder exists
  handle("foundCompany", ({ hires, ...company }) =>
    store.foundCompany({
      ...company,
      hires: hires.map((hire, i) => ({ runner: agentDriver.pickRunner(i), ...hire })),
    }),
  );

  handle("getCompany", store.getCompany);
  handle("loadReport", store.loadReport);
  handle("openSaveFolder", async () => {
    const err = await shell.openPath(ROOT_DIR);
    if (err) {
      throw new Error(err);
    }
  });

  handle("setAutopilot", ({ running }) => setAutopilot(running));

  handle("setBudget", ({ budget }) => {
    const company = store.setBudget(budget);
    if (isOutOfBudget(company)) {
      haltForBudget(company);
    }
    return store.requireCompany();
  });

  handle("resetSpend", store.resetSpend);
  handle("takeDigest", store.takeDigest);

  handle("resetGame", resetGame);

  handle("saveOfficeDesign", ({ json }) => saveOfficeDesign(json));
  handle("loadOfficeDesign", () => ({ layout: loadOfficeDesign() }));

  handle("stripeStatus", () => {
    const company = store.getCompany();
    return company ? getStripeStatus(company.id) : { state: "disconnected" };
  });
  handle("stripeConnect", () => beginConnect(store.requireCompany().id));
  handle("stripeDisconnect", () => disconnectStripe(store.requireCompany().id));

  handle("vercelListProjects", ({ token }) => listVercelProjects(token));
  handle("vercelConnect", connectVercel);
  handle("vercelDisconnect", ({ productId }) => disconnectVercel(productId));

  handle("listProducts", store.listProducts);
  handle("createProduct", (input) => startProduct(input, null));
  handle("killProduct", ({ productId, reason }) => retireProduct(productId, reason, null));
  handle("listBets", store.listBets);
  handle("killBet", ({ betId, reason }) => killBet(betId, reason));
  handle("productStatus", ({ productId }) => productStatus(productId));

  handle("listEmployees", store.listEmployees);
  handle("restingRunners", () => agentDriver.restingRunners());

  handle("employeeOptions", ({ employeeId }) => {
    const emp = store.getEmployee(employeeId);
    if (!emp) {
      throw new Error(`no employee ${employeeId}`);
    }
    return chatOptions(emp, store.openTasksFor(employeeId));
  });

  handle("teamMessages", ({ limit }) => store.recentTeamMessages(limit ?? 30));

  handle("postTeamChat", ({ text }) => scheduler.founderMessage(text.trim()));
  handle("directEmployee", ({ employeeId, instruction }) =>
    scheduler.directEmployee(employeeId, instruction.trim()),
  );

  handle("setMaxAgents", ({ maxAgents }) => store.setMaxAgents(maxAgents));

  handle("listTasks", store.queryTasks);
  handle("shippingLog", store.shippingLog);

  handle("assignTask", ({ taskId, employeeId }) => scheduler.assign(taskId, employeeId));

  handle("answerQuestion", ({ taskId, answer }) => scheduler.answerQuestion(taskId, answer));
  handle("resolveApproval", ({ taskId, approved }) => scheduler.resolveApproval(taskId, approved));

  handle("openCompanyPath", ({ rel }) => openWorkspacePath(rel));
  handle("openProduct", async ({ productId }) => ({ opened: await openProduct(productId) }));
};

const appUrl = (): string => {
  const dev = isDev ? process.env["ELECTRON_RENDERER_URL"] : undefined;
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
// dev gets its own so a dev run never shares a lock or a cache with the app.
if (isDev) {
  app.setPath("userData", path.join(app.getPath("appData"), `${app.name} (dev)`));
}

// one office per machine: a second instance would run a second scheduler
// against the same save, spending twice and racing every write
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", ensureWindow);

void (async () => {
  await app.whenReady();
  // the renderer asks for nothing a game needs: no camera, mic, location, notifications
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Electron callback API
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Electron callback API
    callback(false);
  });
  store.initStore();
  const unreadableSecrets = exportSecretsToEnv();
  if (unreadableSecrets) {
    store.noteUnreadable("secrets", unreadableSecrets.file, unreadableSecrets.cause);
  }
  await adoptShellPath();
  agentDriver.init();
  await controlPlane.start();
  registerIpcHandlers();

  activityEvents.on("activity", (e) => broadcast("onActivity", e));
  scheduler.start();

  metricsPulse.start();

  initStripeConnect({
    notify: (status) => broadcast("onStripeStatus", status),
    onConnected: () => {
      metricsPulse.now();
      scheduler.resumeIntegrationAsks("stripe");
    },
    openExternal: shell.openExternal,
  });
  initVercelConnect({
    onConnected: () => {
      metricsPulse.now();
      scheduler.resumeIntegrationAsks("vercel");
    },
  });

  mainWindow = createWindow();

  appTray.init({
    openWindow: ensureWindow,
    setAutopilot: (on) => {
      if (store.getCompany()) {
        setAutopilot(on);
      }
    },
  });

  app.on("activate", ensureWindow);
})();

app.on("window-all-closed", () => {
  // macOS: stay resident — the tray owns the lifecycle; Quit lives in its menu
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  scheduler.shutdown();
  metricsPulse.stop();
  controlPlane.stop();
});
