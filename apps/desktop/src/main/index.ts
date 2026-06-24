import path from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, shell } from "electron";
import { handle } from "@/main/lib/ipc-handler";
import { broadcast } from "@/main/lib/broadcast";
import { initStore } from "@/main/store/store";
import * as store from "@/main/store/store";
import { piDriver } from "@/main/agents/pi-driver";
import { scheduler } from "@/main/scheduler";
import { startLogin, submitAuthCode, generateCandidates } from "@/main/agents/onboarding";
import { simulatedMetrics, readMetricsConfig, fetchRealMetrics, PULSE_MS } from "@/main/metrics";
import { pluginHost } from "@/main/plugins";
import type { IdleBizPlugin } from "@/main/plugins";
import { exportSecretsToEnv } from "@/main/secrets";
import {
  initStripeConnect,
  beginConnect,
  disconnectStripe,
  getStripeStatus,
  markAuthError,
} from "@/main/stripe-connect";
import { ROOT_DIR } from "@/main/paths";
import { DEFAULT_AGENT_MODEL, HIRE_COST, isOutOfBudget } from "@/shared/domain";
import type { ActivityEvent } from "@/shared/domain";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let metricsTimer: ReturnType<typeof setInterval> | null = null;

/** One pulse of the business metrics loop (also fired on demand, e.g. Stripe connect). */
function runMetricsPulse(): void {
  const company = store.getDefaultCompany();
  if (!company || !company.onboarded) return;
  const cfg = readMetricsConfig(company.id);
  if (cfg) {
    void fetchRealMetrics(cfg).then((snap) => {
      const live = snap.users !== null || snap.revenue !== null;
      if (live) store.setRealMetrics(company.id, snap);
      if (snap.authError) markAuthError("Stripe access was revoked — reconnect in the HUD.");
      broadcast("onActivity", {
        kind: "lifecycle",
        message: "metrics.pulse",
        payload: { users: snap.users, revenue: snap.revenue, real: live },
        createdAt: Date.now(),
      });
    });
    return;
  }
  const p = simulatedMetrics.pulse(company);
  if (p.usersDelta === 0 && p.cashDelta === 0) return;
  store.applyPulse(company.id, p.usersDelta, p.cashDelta);
  broadcast("onActivity", {
    kind: "lifecycle",
    message: "metrics.pulse",
    payload: p,
    createdAt: Date.now(),
  });
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
  store.suspendWrites();
  await piDriver.disposeAll();
  rmSync(ROOT_DIR, { recursive: true, force: true });
  setImmediate(() => {
    app.relaunch();
    app.exit(0);
  });
  return { ok: true };
}

/**
 * Register the built-in plugins. Plugins observe the activity stream and hook
 * the run lifecycle (see main/plugins.ts); this is the seam third-party hooks
 * would extend. The shipped example celebrates shipping milestones in the room.
 */
function registerBuiltinPlugins(): void {
  const shipMilestones: IdleBizPlugin = {
    name: "ship-milestones",
    onActivity: (e) => {
      if (e.kind !== "ship" || !e.employeeId) return;
      const co = store.getDefaultCompany();
      const team = store.teamForEmployee(e.employeeId);
      if (co && team && co.ships > 0 && co.ships % 10 === 0) {
        store.postTeamMessage(
          team.id,
          null,
          `🎉 Milestone: ${co.ships} things shipped — keep going!`,
        );
      }
    },
  };
  pluginHost.register(shipMilestones);
}

function registerIpcHandlers(): void {
  handle("hasAuth", () => ({ ok: piDriver.hasAuth() }));

  handle("startLogin", () => {
    void startLogin((e) => broadcast("onAuthEvent", e));
    return { started: true };
  });

  handle("submitAuthCode", ({ code }) => ({ accepted: submitAuthCode(code) }));

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
    return candidates.map((c, i) => ({
      ...c,
      spriteSeed: `${c.role}-${c.name}-${Date.now().toString(36)}-${i}`,
    }));
  });

  handle("batchHire", ({ companyId, hires }) => {
    hires.forEach((h, i) =>
      store.createEmployee({
        companyId,
        name: h.name,
        role: h.role,
        title: h.title,
        persona: h.persona,
        model: DEFAULT_AGENT_MODEL,
        thinking: null,
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

  handle("createCompany", ({ name, mission, businessType, founderName, founderSpriteSeed }) =>
    store.createCompany({ name, mission, businessType, founderName, founderSpriteSeed }),
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
    if (isOutOfBudget(company) && company.autopilot) {
      store.setAutopilot(companyId, false);
      const e: ActivityEvent = {
        kind: "lifecycle",
        message: "budget.exhausted",
        payload: { spentUsd: company.spentUsd, budget: company.budget },
        createdAt: Date.now(),
      };
      store.logActivity(e);
      broadcast("onActivity", e);
    }
    return store.getCompany(companyId) ?? company;
  });

  handle("resetSpend", ({ companyId }) => store.resetSpend(companyId));

  handle("resetGame", () => resetGame());

  handle("stripeStatus", () => {
    const company = store.getDefaultCompany();
    return company ? getStripeStatus(company.id) : { state: "disconnected" };
  });
  handle("stripeConnect", ({ companyId }) => beginConnect(companyId));
  handle("stripeDisconnect", ({ companyId }) => disconnectStripe(companyId));

  handle("listEmployees", ({ companyId }) => store.listEmployees(companyId));

  handle("createEmployee", (p) => {
    // founding hires (pre-onboarding) are free; later hires cost real (in-game) money
    const company = store.getCompany(p.companyId);
    if (company?.onboarded) {
      if (company.cash < HIRE_COST)
        throw new Error(`Hiring costs $${HIRE_COST} — you have $${company.cash.toFixed(0)}.`);
      store.adjustCash(p.companyId, -HIRE_COST);
    }
    const emp = store.createEmployee({
      companyId: p.companyId,
      name: p.name,
      role: p.role,
      title: p.title,
      persona: p.persona,
      model: p.model ?? DEFAULT_AGENT_MODEL,
      thinking: p.thinking ?? null,
      spriteSeed: p.spriteSeed,
      deskIndex: p.deskIndex,
    });
    // a new hire joins the founding team so they share its chat room + leader
    const team = store.listTeams(p.companyId)[0];
    if (team) {
      const withMember = store.addTeamMember(team.id, emp.id);
      return withMember ? (store.getEmployee(emp.id) ?? emp) : emp;
    }
    return emp;
  });

  handle("listTeams", ({ companyId }) => store.listTeams(companyId));

  handle("teamMessages", ({ teamId, limit }) => store.recentTeamMessages(teamId, limit ?? 30));

  handle("listTasks", ({ companyId }) => store.listTasks(companyId));

  handle("createTask", (p) =>
    store.createTask({
      companyId: p.companyId,
      title: p.title,
      description: p.description ?? null,
      priority: p.priority,
      assigneeId: p.assigneeId ?? null,
    }),
  );

  handle("assignTask", ({ taskId, employeeId }) => scheduler.assign(taskId, employeeId));

  handle("answerQuestion", ({ taskId, answer }) => {
    const continuation = store.resolveBlockedWithAnswer(taskId, answer);
    if (!continuation || !continuation.assigneeId)
      throw new Error("task is not awaiting an answer");
    return scheduler.assign(continuation.id, continuation.assigneeId);
  });

  // open a workspace-relative path with the OS default app ("" = the folder itself)
  const openWorkspacePath = async (companyId: string, rel: string): Promise<void> => {
    const company = store.getCompany(companyId);
    if (!company) throw new Error("company not found");
    const root = path.resolve(company.workspaceDir);
    const target = path.resolve(root, rel === "" ? "." : rel);
    if (target !== root && !target.startsWith(root + path.sep))
      throw new Error("path escapes the workspace");
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  };

  handle("openCompanyPath", async ({ companyId, rel }) => {
    await openWorkspacePath(companyId, rel);
    return { ok: true };
  });

  // open the product via the workspace PRODUCT.md convention ("entry: <path|url>")
  handle("openProduct", async ({ companyId }) => {
    const company = store.getCompany(companyId);
    if (!company) throw new Error("company not found");
    let entry = "index.html";
    try {
      const text = readFileSync(path.join(company.workspaceDir, "PRODUCT.md"), "utf8");
      const m = /^\s*`?entry`?\s*:\s*`?([^`\n]+?)`?\s*$/m.exec(text);
      if (m && m[1]) entry = m[1].trim();
    } catch {
      /* no PRODUCT.md yet — fall back to index.html */
    }
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
  });
  return win;
}

app.whenReady().then(() => {
  initStore();
  exportSecretsToEnv(); // founder keys → env, inherited by every agent's shell
  piDriver.init();
  registerBuiltinPlugins();
  registerIpcHandlers();

  // stream scheduler activity to all windows
  scheduler.events.on("activity", (e: ActivityEvent) => broadcast("onActivity", e));
  // start the idle-game loop: idle employees self-direct work while autopilot is on
  scheduler.start();

  // periodic business pulse. With a metrics.json configured the REAL providers
  // (Stripe revenue + customers, Plausible visitors, custom endpoint) overwrite
  // the numbers; otherwise the light simulation ticks. (Not logged to disk.)
  metricsTimer = setInterval(runMetricsPulse, PULSE_MS);

  initStripeConnect({
    notify: (status) => broadcast("onStripeStatus", status),
    onConnected: () => runMetricsPulse(), // ⚡ flips without waiting 30s
  });

  mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void piDriver.disposeAll();
});
