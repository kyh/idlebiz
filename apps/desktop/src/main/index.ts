import path from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, shell } from "electron";
import { handle } from "@/main/lib/ipc-handler";
import { broadcast } from "@/main/lib/broadcast";
import { initStore } from "@/main/store/store";
import * as store from "@/main/store/store";
import { agentDriver } from "@/main/agents/agent-driver";
import { controlPlane } from "@/main/control-plane";
import { scheduler } from "@/main/scheduler";
import { startLogin, submitAuthCode, generateCandidates } from "@/main/agents/onboarding";
import { readMetricsConfig, writeMetricsConfig, fetchRealMetrics, PULSE_MS } from "@/main/metrics";
import { validateToken, listProjects, latestDeployment } from "@/main/vercel";
import { pluginHost } from "@/main/plugins";
import type { IdleBizPlugin } from "@/main/plugins";
import { exportSecretsToEnv, getSecret, setSecret, deleteSecret } from "@/main/secrets";
import {
  initStripeConnect,
  beginConnect,
  disconnectStripe,
  getStripeStatus,
  markAuthError,
} from "@/main/stripe-connect";
import { ROOT_DIR, OFFICE_DESIGN_PATH } from "@/main/paths";
import { isAgentRunner, isOutOfBudget, parseIntegrationAsk } from "@/shared/domain";
import type { ActivityEvent, IntegrationKind } from "@/shared/domain";

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
    broadcast("onActivity", {
      kind: "lifecycle",
      message: "metrics.pulse",
      payload: { users: snap.users, revenue: snap.revenue, real: live },
      createdAt: Date.now(),
    });
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
  store.suspendWrites();
  agentDriver.disposeAll();
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

/**
 * When the founder connects an integration, every task blocked on a typed
 * ask for it resumes automatically (paperclip's wake-assignee convention).
 */
function resumeIntegrationAsks(kind: IntegrationKind): void {
  const company = store.getDefaultCompany();
  if (!company) return;
  for (const task of store.listTasks(company.id)) {
    if (task.status !== "blocked" || !task.blockedQuestion) continue;
    if (parseIntegrationAsk(task.blockedQuestion)?.kind !== kind) continue;
    const continuation = store.resolveBlockedWithAnswer(
      task.id,
      `${kind === "vercel" ? "Vercel" : "Stripe"} is now connected — the credentials are in your environment. Continue where you left off.`,
    );
    if (continuation?.assigneeId) {
      try {
        scheduler.assign(continuation.id, continuation.assigneeId);
      } catch {
        /* busy — the queue picks it up next tick */
      }
    }
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

function registerIpcHandlers(): void {
  handle("hasAuth", () => ({ ok: agentDriver.hasAnyRunner() }));

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

  // The office builder (#/ui) persists the layout to ~/.idlebiz, recovered at next
  // launch (see store.refresh → applyOfficeLayout). Survives rebuilds + packaging.
  handle("saveOfficeDesign", ({ json }) => {
    const parsed: unknown = JSON.parse(json); // reject malformed before writing
    const body = `${JSON.stringify(parsed, null, 2)}\n`;
    mkdirSync(ROOT_DIR, { recursive: true });
    writeFileSync(OFFICE_DESIGN_PATH, body);
    // dev: mirror into the repo source so edited maps ship as the bundled
    // default (main runs from .output/app/main — three levels up = app root)
    if (!app.isPackaged) {
      const repoDesign = path.resolve(moduleDir, "../../../src/renderer/game/office-design.json");
      if (existsSync(path.dirname(repoDesign))) writeFileSync(repoDesign, body);
    }
    return { ok: true };
  });
  handle("loadOfficeDesign", () => {
    if (!existsSync(OFFICE_DESIGN_PATH)) return { layout: null };
    const layout: unknown = JSON.parse(readFileSync(OFFICE_DESIGN_PATH, "utf8"));
    return { layout };
  });

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
    return {
      state: "connected",
      projectId: cfg.vercel.projectId,
      projectName: cfg.vercel.projectName ?? cfg.vercel.projectId,
    };
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
    resumeIntegrationAsks("vercel"); // agents waiting on hosting get back to work
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
    return { ships: company.ships, entry: readProductEntry(company.workspaceDir), deploy };
  });

  handle("listEmployees", ({ companyId }) => store.listEmployees(companyId));

  handle("createEmployee", (p) => {
    const emp = store.createEmployee({
      companyId: p.companyId,
      name: p.name,
      role: p.role,
      title: p.title,
      persona: p.persona,
      runner: p.runner && isAgentRunner(p.runner) ? p.runner : agentDriver.pickRunner(p.deskIndex),
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
  });
  return win;
}

void (async () => {
  await app.whenReady();
  initStore();
  exportSecretsToEnv(); // founder keys → env, inherited by every agent's shell
  agentDriver.init(); // probe installed CLIs (claude / codex)
  await controlPlane.start(); // loopback API running agents curl back into
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
    onConnected: () => {
      runMetricsPulse(); // ⚡ flips without waiting 30s
      resumeIntegrationAsks("stripe"); // agents waiting on payments resume
    },
  });

  mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
})();

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  agentDriver.disposeAll();
  controlPlane.stop();
});
