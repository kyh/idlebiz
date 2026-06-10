import path from "node:path";
import { readFileSync } from "node:fs";
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
import { exportSecretsToEnv } from "@/main/secrets";
import { DEFAULT_AGENT_MODEL, HIRE_COST } from "@/shared/domain";
import type { ActivityEvent } from "@/shared/domain";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;

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

  handle("generateHires", async ({ companyName, mission }) => {
    const candidates = await generateCandidates({ companyName, mission });
    return candidates.map((c, i) => ({
      ...c,
      spriteSeed: `${c.role}-${c.name}-${Date.now().toString(36)}-${i}`,
    }));
  });

  handle("batchHire", ({ companyId, hires }) =>
    hires.map((h, i) =>
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
    ),
  );

  handle("completeOnboarding", ({ companyId }) => {
    store.setCompanyOnboarded(companyId, true);
    const company = store.getCompany(companyId);
    if (!company) throw new Error("company not found");
    return company;
  });

  handle("getCompany", () => store.getDefaultCompany());

  handle("createCompany", ({ name, mission, founderName, founderSpriteSeed }) =>
    store.createCompany({ name, mission, founderName, founderSpriteSeed }),
  );

  handle("setAutopilot", ({ companyId, running }) => {
    store.setAutopilot(companyId, running);
    const company = store.getCompany(companyId);
    if (!company) throw new Error("company not found");
    return company;
  });

  handle("listEmployees", ({ companyId }) => store.listEmployees(companyId));

  handle("createEmployee", (p) => {
    // founding hires (pre-onboarding) are free; later hires cost real (in-game) money
    const company = store.getCompany(p.companyId);
    if (company?.onboarded) {
      if (company.cash < HIRE_COST)
        throw new Error(`Hiring costs $${HIRE_COST} — you have $${company.cash.toFixed(0)}.`);
      store.adjustCash(p.companyId, -HIRE_COST);
    }
    return store.createEmployee({
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
  });

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
  registerIpcHandlers();

  // stream scheduler activity to all windows
  scheduler.events.on("activity", (e: ActivityEvent) => broadcast("onActivity", e));
  // start the idle-game loop: idle employees self-direct work while autopilot is on
  scheduler.start();

  // periodic business pulse. With a metrics.json configured the REAL providers
  // (Stripe revenue, Plausible visitors, custom endpoint) overwrite the numbers;
  // otherwise the light simulation ticks. (Pulse events aren't logged to disk.)
  setInterval(() => {
    const company = store.getDefaultCompany();
    if (!company || !company.onboarded) return;
    const cfg = readMetricsConfig(company.id);
    if (cfg) {
      void fetchRealMetrics(cfg).then((snap) => {
        const live = snap.users !== null || snap.revenue !== null;
        if (live) store.setRealMetrics(company.id, snap);
        broadcast("onActivity", {
          kind: "lifecycle",
          message: "metrics.pulse",
          payload: { ...snap, real: live },
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
  }, PULSE_MS);

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
