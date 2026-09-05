import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, session, shell } from "electron";
import { handle } from "@/main/lib/ipc-handler";
import { broadcast } from "@/main/lib/broadcast";
import { atomicWrite, readJsonFile, suspendWrites } from "@/main/lib/fs";
import * as store from "@/main/store/store";
import { activityEvents, publishActivity } from "@/main/activity";
import { agentDriver } from "@/main/agents/agent-driver";
import { controlPlane } from "@/main/control-plane";
import { openProduct, openWorkspacePath, productEntry } from "@/main/product";
import { chatOptions } from "@/main/prompts/chat-options";
import { scheduler } from "@/main/scheduler";
import { appTray } from "@/main/tray";
import { startLogin, generateCandidates } from "@/main/agents/onboarding";
import { readMetricsConfig, fetchRealMetrics, PULSE_MS } from "@/main/metrics";
import { latestDeployment } from "@/main/vercel";
import {
  connectVercel,
  disconnectVercel,
  initVercelConnect,
  listVercelProjects,
} from "@/main/vercel-connect";
import { exportSecretsToEnv } from "@/main/secrets";
import {
  initStripeConnect,
  beginConnect,
  disconnectStripe,
  getStripeStatus,
  markAuthError,
} from "@/main/stripe-connect";
import { ROOT_DIR, OFFICE_DESIGN_PATH } from "@/main/paths";
import { isOutOfBudget, spriteSeedFor, type Task } from "@/shared/domain";
import { canonicalOfficeLayout, parseOfficeLayout } from "@/shared/office-layout-schema";
import { layoutIssues } from "@/shared/office-grid";
import { jsonValueSchema, parseJson } from "@/shared/json";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let metricsTimer: ReturnType<typeof setInterval> | null = null;

/** One pulse of the business metrics loop (also fired on demand, e.g. Stripe connect).
 * Real sources only — with nothing connected there are no numbers to move. */
function runMetricsPulse(): void {
  const company = store.getDefaultCompany();
  if (!company) return;
  const products = store.listProducts(company.id);
  const cfg = readMetricsConfig(company.id);
  // nothing to ask anyone: no provider configured, no product bound
  if (!cfg?.stripe && !cfg?.plausible && !cfg?.custom && products.every((p) => p.vercel === null))
    return;
  void (async () => {
    const snap = await fetchRealMetrics(cfg, products);
    store.setRealMetrics(company.id, snap);
    for (const [productId, users] of snap.productUsers) store.setProductUsers(productId, users);
    if (snap.authError) markAuthError("Stripe access was revoked — reconnect in the HUD.");
    publishActivity(
      { kind: "metrics.pulse", payload: { users: snap.users, revenue: snap.revenue } },
      { persist: false },
    );
  })();
}

/**
 * Full reset: stop every writer, abort live agent runs, then wipe ~/.idlebiz
 * (companies, workspaces, auth, secrets) and relaunch into onboarding.
 * Order matters — suspend writes BEFORE disposing so settling runs can't
 * resurrect files after the rm.
 */
async function resetGame(): Promise<{ ok: boolean }> {
  scheduler.stop();
  if (metricsTimer) clearInterval(metricsTimer);
  suspendWrites();
  agentDriver.disposeAll();
  rmSync(ROOT_DIR, { recursive: true, force: true });
  setImmediate(() => {
    app.relaunch();
    app.exit(0);
  });
  return { ok: true };
}

function registerIpcHandlers(): void {
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
    const { listFounderChoices, composeCharacter } = await import("@/main/character/compositor");
    const seeds = await listFounderChoices(6);
    return Promise.all(
      seeds.map(async (seed) => {
        const assets = await composeCharacter(seed);
        return { seed, portraitDataUrl: assets.portraitDataUrl };
      }),
    );
  });

  handle("generateHires", async ({ companyName, mission, businessType }) => {
    const candidates = await generateCandidates({ companyName, mission, businessType });
    return candidates.map((c, i) =>
      Object.assign(c, { spriteSeed: spriteSeedFor(c.role, c.name, `-${i}`) }),
    );
  });

  // one call, whole or not at all: the roster's CLIs are chosen first, so a
  // machine with nothing signed in fails before a folder exists
  handle("foundCompany", ({ hires, ...company }) =>
    store.foundCompany({
      ...company,
      hires: hires.map((h, i) => Object.assign({ runner: agentDriver.pickRunner(i) }, h)),
    }),
  );

  handle("getCompany", () => store.getDefaultCompany());
  handle("loadReport", () => store.loadReport());
  handle("openSaveFolder", async () => {
    const err = await shell.openPath(ROOT_DIR);
    if (err) throw new Error(err);
    return { ok: true };
  });

  handle("setAutopilot", ({ companyId, running }) => store.setAutopilot(companyId, running));

  handle("setBudget", ({ companyId, budget }) => {
    const company = store.setBudget(companyId, budget);
    // setting a cap below what's already spent pauses the office immediately
    if (isOutOfBudget(company)) scheduler.haltForBudget(company);
    return store.requireCompany(companyId);
  });

  handle("resetSpend", ({ companyId }) => store.resetSpend(companyId));

  handle("resetGame", () => resetGame());

  // The office builder (#/ui) persists the layout to ~/.idlebiz, recovered at next
  // launch (see store.refresh → applyOfficeLayout). Survives rebuilds + packaging.
  //
  // Refused here, with reasons, rather than written and then silently replaced by
  // the bundled office at next boot: a layout that fits the schema but seats
  // someone in a sealed room is as broken as one that does not parse.
  handle("saveOfficeDesign", ({ json }) => {
    const layout = parseOfficeLayout(parseJson(json));
    const issues = layoutIssues(layout);
    if (issues.length > 0) throw new Error(`office layout rejected:\n${issues.join("\n")}`);
    const body = `${JSON.stringify(canonicalOfficeLayout(layout), null, 2)}\n`;
    atomicWrite(OFFICE_DESIGN_PATH, body);
    // dev: mirror into the repo source so edited maps ship as the bundled
    // default (main runs from .output/app/main — three levels up = app root)
    if (!app.isPackaged) {
      const repoDesign = path.resolve(moduleDir, "../../../src/renderer/game/office-design.json");
      if (existsSync(path.dirname(repoDesign))) atomicWrite(repoDesign, body);
    }
    return { ok: true };
  });
  handle("loadOfficeDesign", () => ({
    layout: readJsonFile(OFFICE_DESIGN_PATH, jsonValueSchema),
  }));

  handle("stripeStatus", () => {
    const company = store.getDefaultCompany();
    return company ? getStripeStatus(company.id) : { state: "disconnected" };
  });
  handle("stripeConnect", ({ companyId }) => beginConnect(companyId));
  handle("stripeDisconnect", ({ companyId }) => disconnectStripe(companyId));

  handle("vercelListProjects", ({ token }) => listVercelProjects(token));
  handle("vercelConnect", (input) => {
    connectVercel(input);
    return { ok: true };
  });
  handle("vercelDisconnect", ({ productId }) => {
    disconnectVercel(productId);
    return { ok: true };
  });

  handle("listProducts", ({ companyId }) => store.listProducts(companyId));
  handle("createProduct", ({ companyId, name, description }) => {
    const product = store.createProduct({ companyId, name, description });
    publishActivity({
      kind: "product.created",
      message: product.name,
      payload: { productId: product.id },
    });
    return product;
  });
  handle("productStatus", async ({ productId }) => {
    const { vercel } = store.requireProduct(productId);
    const deploy = vercel
      ? await latestDeployment(vercel.projectId, vercel.teamId ?? undefined)
      : null;
    return { entry: productEntry(productId), deploy };
  });

  handle("listEmployees", ({ companyId }) => store.listEmployees(companyId));
  handle("restingRunners", () => agentDriver.restingRunners());

  handle("employeeOptions", ({ employeeId }) => {
    const emp = store.getEmployee(employeeId);
    if (!emp) throw new Error(`no employee ${employeeId}`);
    const mine = (t: Task) => t.assigneeId === employeeId;
    return chatOptions(
      emp,
      store.openTasksFor(employeeId),
      store.listShippedTasks(emp.companyId).filter(mine),
    );
  });

  handle("teamMessages", ({ companyId, limit }) =>
    store.recentTeamMessages(companyId, limit ?? 30),
  );

  // the founder types in the room; @first-name wakes that employee
  handle("postTeamChat", ({ companyId, text }) => {
    scheduler.founderMessage(companyId, text.trim());
    return { ok: true };
  });

  handle("directEmployee", ({ employeeId, instruction }) => {
    scheduler.directEmployee(employeeId, instruction.trim());
    return { ok: true };
  });

  handle("setMaxAgents", ({ companyId, maxAgents }) => store.setMaxAgents(companyId, maxAgents));

  // filtered in main: the shipping log is thousands of briefs, read only when asked for
  handle("listTasks", ({ companyId, assigneeId, status }) => {
    const wantsShipped = status === undefined || status.includes("done");
    const pool = wantsShipped
      ? [...store.listOpenTasks(companyId), ...store.listShippedTasks(companyId)]
      : store.listOpenTasks(companyId);
    return pool
      .filter((t) => assigneeId === undefined || t.assigneeId === assigneeId)
      .filter((t) => status === undefined || status.includes(t.state.kind))
      .toSorted((a, b) => b.createdAt - a.createdAt);
  });

  handle("assignTask", ({ taskId, employeeId }) => scheduler.assign(taskId, employeeId));

  handle("answerQuestion", ({ taskId, answer }) => scheduler.answerQuestion(taskId, answer));
  handle("resolveApproval", ({ taskId, approved }) => scheduler.resolveApproval(taskId, approved));

  handle("openCompanyPath", async ({ companyId, rel }) => {
    await openWorkspacePath(companyId, rel);
    return { ok: true };
  });
  handle("openProduct", async ({ productId }) => ({
    ok: true,
    opened: await openProduct(productId),
  }));
}

/** Where the renderer lives: the dev server under electron-vite, the built file otherwise. */
function appUrl(): string {
  const dev = isDev ? process.env["ELECTRON_RENDERER_URL"] : undefined;
  return dev ?? pathToFileURL(path.join(moduleDir, "../renderer/index.html")).toString();
}

/** A link the OS browser may open: http(s) and nothing else, judged by a parsed URL. */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: "#12141c",
    title: "IdleBiz",
    webPreferences: {
      preload: path.join(moduleDir, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // the window shows this app and nothing else: a dropped file, a link, an
  // agent-written page would otherwise navigate the renderer — bridge intact
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== appUrl()) event.preventDefault();
  });

  win.once("ready-to-show", () => win.show());

  void win.loadURL(appUrl());
  if (isDev) win.webContents.openDevTools({ mode: "detach" });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // background mac app: no windows → no dock icon, just the tray briefcase
    // (which badges + notifies when the office is still actively working)
    if (BrowserWindow.getAllWindows().length === 0) {
      app.dock?.hide();
      appTray.setWindowless(true);
    }
  });
  return win;
}

/** Bring the office back: focus the open window or create one (dock returns too). */
function ensureWindow(): void {
  void app.dock?.show();
  appTray.setWindowless(false);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = createWindow();
}

// Electron names the app, and so its userData, after package.json's productName;
// dev gets its own so a dev run never shares a lock or a cache with the app.
if (isDev) app.setPath("userData", path.join(app.getPath("appData"), `${app.name} (dev)`));

// one office per machine: a second instance would run a second scheduler
// against the same save, spending twice and racing every write
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", ensureWindow);

void (async () => {
  await app.whenReady();
  // the renderer asks for nothing a game needs: no camera, mic, location, notifications
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  store.initStore();
  exportSecretsToEnv(); // founder keys → env, inherited by every agent's shell
  agentDriver.init(); // probe installed CLIs (claude / codex)
  await controlPlane.start(); // loopback API running agents curl back into
  registerIpcHandlers();

  activityEvents.on("activity", (e) => broadcast("onActivity", e));
  // start the idle-game loop: idle employees self-direct work while autopilot is on
  scheduler.start();

  // periodic business pulse: with a metrics.json configured, the real providers
  // (Stripe revenue + customers, Vercel) refresh the company's numbers
  metricsTimer = setInterval(runMetricsPulse, PULSE_MS);

  // an integration just connected: the numbers flip without waiting for the
  // pulse, and every task blocked on that integration resumes
  initStripeConnect({
    notify: (status) => broadcast("onStripeStatus", status),
    onConnected: () => {
      runMetricsPulse();
      scheduler.resumeIntegrationAsks("stripe");
    },
  });
  initVercelConnect({
    onConnected: () => {
      runMetricsPulse();
      scheduler.resumeIntegrationAsks("vercel");
    },
  });

  mainWindow = createWindow();

  // the menu-bar presence: closing the window leaves the office running here
  appTray.init({
    openWindow: ensureWindow,
    setAutopilot: (on) => {
      const company = store.getDefaultCompany();
      if (!company) return;
      store.setAutopilot(company.id, on);
      publishActivity({ kind: "autopilot.changed", payload: { on } });
    },
  });

  app.on("activate", () => ensureWindow());
})();

app.on("window-all-closed", () => {
  // macOS: stay resident — the tray owns the lifecycle; Quit lives in its menu
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  agentDriver.disposeAll();
  controlPlane.stop();
});
