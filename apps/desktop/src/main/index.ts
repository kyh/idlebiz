import path from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, shell } from "electron";
import { handle } from "@/main/lib/ipc-handler";
import { broadcast } from "@/main/lib/broadcast";
import { atomicWrite, readJsonFile, suspendWrites } from "@/main/lib/fs";
import * as store from "@/main/store/store";
import { activityEvents, publishActivity } from "@/main/activity";
import { agentDriver } from "@/main/agents/agent-driver";
import { controlPlane } from "@/main/control-plane";
import { approvalAnswer } from "@/main/prompts/briefs";
import { scheduler } from "@/main/scheduler";
import { appTray } from "@/main/tray";
import { startLogin, generateCandidates } from "@/main/agents/onboarding";
import { readMetricsConfig, fetchRealMetrics, PULSE_MS } from "@/main/metrics";
import { latestDeployment } from "@/main/vercel";
import {
  connectVercel,
  disconnectVercel,
  getVercelStatus,
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
import { isOutOfBudget, spriteSeedFor } from "@/shared/domain";
import { canonicalOfficeLayout, parseOfficeLayout } from "@/shared/office-layout-schema";
import { layoutIssues } from "@/shared/office-grid";
import type { ActivityEvent } from "@/shared/activity";
import type { Task } from "@/shared/domain";
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
  const cfg = readMetricsConfig(company.id);
  if (!cfg) return;
  void (async () => {
    const snap = await fetchRealMetrics(cfg);
    const live = snap.users !== null || snap.revenue !== null;
    if (live) store.setRealMetrics(company.id, snap);
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

/** Every tenth ship gets a cheer in the team room. */
function celebrateShipMilestones(e: ActivityEvent): void {
  if (e.kind !== "ship" || !e.employeeId) return;
  const co = store.getEmployee(e.employeeId)?.companyId;
  const company = co ? store.getCompany(co) : null;
  if (company && company.ships > 0 && company.ships % 10 === 0) {
    store.postTeamMessage(
      company.id,
      null,
      `🎉 Milestone: ${company.ships} things shipped — keep going!`,
    );
  }
}

/** The workspace PRODUCT.md `entry:` convention — how the team points at the product. */
function readProductEntry(workspaceDir: string): string | null {
  try {
    const text = readFileSync(path.join(workspaceDir, "PRODUCT.md"), "utf8");
    const m = /^\s*`?entry`?\s*:\s*`?([^`\n]+?)`?\s*$/m.exec(text);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null; // no PRODUCT.md yet
  }
}

async function openWorkspacePath(companyId: string, rel: string): Promise<void> {
  const root = path.resolve(store.requireCompany(companyId).workspaceDir);
  const target = path.resolve(root, rel === "" ? "." : rel);
  if (target !== root && !target.startsWith(root + path.sep))
    throw new Error("path escapes the workspace");
  const err = await shell.openPath(target);
  if (err) throw new Error(err);
}

/** Every blocked-ask type resumes the same way: answer it, then run the continuation. */
function resumeBlocked(taskId: string, answer: string, whenNotBlocked: string): Task {
  const continuation = store.resolveBlockedWithAnswer(taskId, answer);
  if (!continuation || !continuation.assigneeId) throw new Error(whenNotBlocked);
  return scheduler.assign(continuation.id, continuation.assigneeId);
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

  handle("vercelStatus", () => {
    const company = store.getDefaultCompany();
    return company ? getVercelStatus(company.id) : { state: "disconnected" };
  });
  handle("vercelListProjects", ({ token }) => listVercelProjects(token));
  handle("vercelConnect", (input) => {
    connectVercel(input);
    return { ok: true };
  });
  handle("vercelDisconnect", ({ companyId }) => {
    disconnectVercel(companyId);
    return { ok: true };
  });

  handle("productStatus", async ({ companyId }) => {
    const company = store.requireCompany(companyId);
    const cfg = readMetricsConfig(companyId);
    const deploy = cfg?.vercel
      ? await latestDeployment(cfg.vercel.projectId, cfg.vercel.teamId)
      : null;
    return { entry: readProductEntry(company.workspaceDir), deploy };
  });

  handle("listEmployees", ({ companyId }) => store.listEmployees(companyId));
  handle("restingRunners", () => agentDriver.restingRunners());

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

  handle("answerQuestion", ({ taskId, answer }) =>
    resumeBlocked(taskId, answer, "task is not awaiting an answer"),
  );

  handle("resolveApproval", ({ taskId, approved }) => {
    const task = store.getTask(taskId);
    if (!task || task.state.kind !== "blocked" || task.state.ask.type !== "approval")
      throw new Error("task is not awaiting an approval");
    // Record before resuming: the agent's retry hits the hook again, and it
    // must find the sign-off already there.
    if (approved) store.grantApproval(task.companyId, task.state.ask.command);
    return resumeBlocked(taskId, approvalAnswer(approved), "could not resume the task");
  });

  // open a workspace-relative path with the OS default app ("" = the folder itself)
  handle("openCompanyPath", async ({ companyId, rel }) => {
    await openWorkspacePath(companyId, rel);
    return { ok: true };
  });

  // open the product via the workspace PRODUCT.md convention ("entry: <path|url>")
  handle("openProduct", async ({ companyId }) => {
    const entry = readProductEntry(store.requireCompany(companyId).workspaceDir) ?? "index.html";
    if (/^https?:\/\//.test(entry)) {
      await shell.openExternal(entry);
      return { ok: true, opened: entry };
    }
    await openWorkspacePath(companyId, entry);
    return { ok: true, opened: entry };
  });
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
    if (url.startsWith("http")) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.once("ready-to-show", () => win.show());

  if (isDev && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    void win.loadFile(path.join(moduleDir, "../renderer/index.html"));
  }

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

void (async () => {
  await app.whenReady();
  store.initStore();
  exportSecretsToEnv(); // founder keys → env, inherited by every agent's shell
  agentDriver.init(); // probe installed CLIs (claude / codex)
  await controlPlane.start(); // loopback API running agents curl back into
  registerIpcHandlers();

  activityEvents.on("activity", (e) => broadcast("onActivity", e));
  activityEvents.on("activity", celebrateShipMilestones);
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
