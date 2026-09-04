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
import { scheduler } from "@/main/scheduler";
import { appTray } from "@/main/tray";
import { startLogin, generateCandidates } from "@/main/agents/onboarding";
import { readMetricsConfig, writeMetricsConfig, fetchRealMetrics, PULSE_MS } from "@/main/metrics";
import { validateToken, listProjects, latestDeployment } from "@/main/vercel";
import { exportSecretsToEnv, getSecret, setSecret, deleteSecret } from "@/main/secrets";
import {
  initStripeConnect,
  beginConnect,
  disconnectStripe,
  getStripeStatus,
  markAuthError,
} from "@/main/stripe-connect";
import { ROOT_DIR, OFFICE_DESIGN_PATH } from "@/main/paths";
import { isOutOfBudget } from "@/shared/domain";
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
  if (!company || !company.onboarded) return;
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
  const co = store.getDefaultCompany();
  const team = store.teamForEmployee(e.employeeId);
  if (co && team && co.ships > 0 && co.ships % 10 === 0) {
    store.postTeamMessage(team.id, null, `🎉 Milestone: ${co.ships} things shipped — keep going!`);
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
  const company = store.getCompany(companyId);
  if (!company) throw new Error("company not found");
  const root = path.resolve(company.workspaceDir);
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
      Object.assign(c, { spriteSeed: `${c.role}-${c.name}-${Date.now().toString(36)}-${i}` }),
    );
  });

  handle("batchHire", ({ companyId, hires }) => {
    hires.forEach((h, i) =>
      store.createEmployee({
        companyId,
        name: h.name,
        role: h.role,
        title: h.title,
        persona: h.persona,
        runner: agentDriver.pickRunner(i), // mixed roster across installed CLIs
        spriteSeed: h.spriteSeed,
        deskIndex: i,
      }),
    );
    // form the founding team (leader + all hires) once the roster exists
    const company = store.getCompany(companyId);
    if (company && store.listTeams(companyId).length === 0) store.foundingTeamFor(company);
    return store.listEmployees(companyId);
  });

  handle("completeOnboarding", ({ companyId }) => {
    store.setCompanyOnboarded(companyId, true);
    const company = store.getCompany(companyId);
    if (!company) throw new Error("company not found");
    return company;
  });

  handle("getCompany", () => store.getDefaultCompany());

  handle(
    "createCompany",
    ({ name, mission, businessType, founderName, founderSpriteSeed, budget }) =>
      store.createCompany({ name, mission, businessType, founderName, founderSpriteSeed, budget }),
  );

  handle("setAutopilot", ({ companyId, running }) => {
    store.setAutopilot(companyId, running);
    const company = store.getCompany(companyId);
    if (!company) throw new Error("company not found");
    return company;
  });

  handle("setBudget", ({ companyId, budget }) => {
    const company = store.setBudget(companyId, budget);
    // setting a cap below what's already spent pauses the office immediately
    if (isOutOfBudget(company)) scheduler.haltForBudget(company);
    return store.getCompany(companyId) ?? company;
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
    const cfg = company ? readMetricsConfig(company.id) : null;
    if (!cfg?.vercel || !getSecret("VERCEL_TOKEN")) return { state: "disconnected" };
    return { state: "connected", projectName: cfg.vercel.projectName ?? cfg.vercel.projectId };
  });

  handle("vercelListProjects", async ({ token }) => {
    const check = await validateToken(token.trim());
    if (!check.ok) return { ok: false, projects: [] };
    const projects = await listProjects(token.trim());
    return { ok: true, account: check.account, projects };
  });

  handle("vercelConnect", ({ companyId, token, projectId, projectName, teamId }) => {
    setSecret("VERCEL_TOKEN", token.trim()); // metrics pulse + agents' `vercel` CLI
    writeMetricsConfig(companyId, {
      vercel: teamId ? { projectId, projectName, teamId } : { projectId, projectName },
    });
    runMetricsPulse(); // users flip without waiting 30s
    scheduler.resumeIntegrationAsks("vercel"); // agents waiting on hosting get back to work
    return { ok: true };
  });

  handle("vercelDisconnect", ({ companyId }) => {
    writeMetricsConfig(companyId, { vercel: undefined });
    deleteSecret("VERCEL_TOKEN");
    return { ok: true };
  });

  handle("productStatus", async ({ companyId }) => {
    const company = store.getCompany(companyId);
    if (!company) throw new Error("company not found");
    const cfg = readMetricsConfig(companyId);
    const deploy = cfg?.vercel
      ? await latestDeployment(cfg.vercel.projectId, cfg.vercel.teamId)
      : null;
    return { entry: readProductEntry(company.workspaceDir), deploy };
  });

  handle("listEmployees", ({ companyId }) => store.listEmployees(companyId));

  handle("listTeams", ({ companyId }) => store.listTeams(companyId));

  handle("teamMessages", ({ teamId, limit }) => store.recentTeamMessages(teamId, limit ?? 30));

  // the founder types in the team channel; @first-name wakes that employee
  handle("postTeamChat", ({ teamId, text }) => {
    const company = store.getDefaultCompany();
    if (!company) throw new Error("no company");
    scheduler.founderMessage(company.id, teamId, text.trim());
    return { ok: true };
  });

  handle("setMaxAgents", ({ companyId, maxAgents }) => store.setMaxAgents(companyId, maxAgents));

  // filtered in main: the full history is thousands of briefs the renderer never shows
  handle("listTasks", ({ companyId, assigneeId, status }) =>
    store
      .listTasks(companyId)
      .filter((t) => assigneeId === undefined || t.assigneeId === assigneeId)
      .filter((t) => status === undefined || status.includes(t.status)),
  );

  handle("assignTask", ({ taskId, employeeId }) => scheduler.assign(taskId, employeeId));

  handle("answerQuestion", ({ taskId, answer }) =>
    resumeBlocked(taskId, answer, "task is not awaiting an answer"),
  );

  handle("resolveApproval", ({ taskId, approved }) => {
    const task = store.getTask(taskId);
    if (!task || task.blocked?.type !== "approval")
      throw new Error("task is not awaiting an approval");
    // Record before resuming: the agent's retry hits the hook again, and it
    // must find the sign-off already there.
    if (approved) store.grantApproval(task.companyId, task.blocked.command);
    return resumeBlocked(
      taskId,
      approved
        ? "Approved — run it once. The sign-off covers this one command this one time, so running it again, or anything else outward-facing, needs a fresh approval."
        : "Not approved. Do not run it, and do not look for another way to achieve the same effect. Continue with the rest of the work.",
      "could not resume the task",
    );
  });

  // open a workspace-relative path with the OS default app ("" = the folder itself)
  handle("openCompanyPath", async ({ companyId, rel }) => {
    await openWorkspacePath(companyId, rel);
    return { ok: true };
  });

  // open the product via the workspace PRODUCT.md convention ("entry: <path|url>")
  handle("openProduct", async ({ companyId }) => {
    const company = store.getCompany(companyId);
    if (!company) throw new Error("company not found");
    const entry = readProductEntry(company.workspaceDir) ?? "index.html";
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

  initStripeConnect({
    notify: (status) => broadcast("onStripeStatus", status),
    onConnected: () => {
      runMetricsPulse(); // ⚡ flips without waiting 30s
      scheduler.resumeIntegrationAsks("stripe"); // agents waiting on payments resume
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
