import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, expect, test as base } from "@playwright/test";
import type { ElectronApplication, JSHandle, Page } from "@playwright/test";
import type { Company, Employee, Product } from "@/shared/domain";
import type { HireProposal } from "@/shared/hire";
import type { AppBridge } from "@/shared/ipc-registry";
import { jsonRecordSchema, parseJson } from "@/shared/json";
import type { JsonRecord, JsonValue } from "@/shared/json";

declare global {
  // What the preload exposes on the window; renderer/bridge.ts declares it for the app.
  var appBridge: AppBridge | undefined;
}

const DESKTOP_DIR = path.resolve(import.meta.dirname, "..");

interface Launched {
  app: ElectronApplication;
  page: Page;
}

interface Fixtures {
  /** A fresh save root for this test, deleted after it. */
  root: string;
  /** Start the built app on `root`, as `electron .` does; whatever is still open closes when the test ends. */
  launch: () => Promise<Launched>;
}

/** Every `run.start` any company on `root` logged: each one would have been a paid CLI session. */
const runsStarted = async (root: string): Promise<number> => {
  let started = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const log = path.join(root, entry.name, "activity.jsonl");
    if (!entry.isDirectory() || !existsSync(log)) {
      continue;
    }
    const lines = await readFile(log, "utf-8");
    for (const line of lines.split("\n")) {
      if (line.trim() !== "" && jsonRecordSchema.parse(parseJson(line)).kind === "run.start") {
        started += 1;
      }
    }
  }
  return started;
};

const start = async (root: string): Promise<Launched> => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      // a dev shell's renderer URL would load the dev server instead of the build
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RENDERER_URL",
    ),
  );
  // Playwright's Electron loader forces Chromium's mock keychain (and --password-store=basic)
  // on every launch, so no e2e launch reaches the real Keychain and this suite cannot see
  // whether dev appends its own switch.
  const app = await _electron.launch({
    args: [DESKTOP_DIR],
    cwd: DESKTOP_DIR,
    env: { ...env, IDLEBIZ_ROOT_DIR: root },
  });
  const page = await app.firstWindow();
  // Phaser stalls on a hidden document, and an unpackaged launch opens DevTools over the window.
  await app.evaluate(({ BrowserWindow, app: electronApp }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const { webContents } = win;
      webContents.on("devtools-opened", () => webContents.closeDevTools());
      webContents.closeDevTools();
      win.show();
      win.focus();
    }
    electronApp.focus({ steal: true });
  });
  return { app, page };
};

export const test = base.extend<Fixtures>({
  launch: async ({ root }, provide) => {
    const open = new Set<ElectronApplication>();
    await provide(async () => {
      const launched = await start(root);
      open.add(launched.app);
      launched.app.once("close", () => open.delete(launched.app));
      return launched;
    });
    for (const app of open) {
      await app.close();
    }
  },
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern; the root has none
  root: async ({}, provide) => {
    const root = await mkdtemp(path.join(tmpdir(), "idlebiz-e2e-"));
    try {
      await provide(root);
      expect(await runsStarted(root), "no employee run may start").toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
});

export { expect } from "@playwright/test";

/** The preload's bridge, called as the renderer calls it. */
export const bridgeOf = (page: Page): Promise<JSHandle<AppBridge>> =>
  page.evaluateHandle(() => {
    const bridge = globalThis.appBridge;
    if (!bridge) {
      throw new Error("the preload exposed no appBridge");
    }
    return bridge;
  });

const HIRES: HireProposal[] = [
  {
    blurb: "Keeps the team pointed at the numbers.",
    name: "Ada Park",
    persona: "A calm team lead who picks the next bet from the real numbers.",
    role: "lead",
    spriteSeed: "e2e-ada",
    title: "Team Lead",
  },
  {
    blurb: "Builds and ships the product.",
    name: "Bo Chen",
    persona: "A founding engineer who ships small, working slices.",
    role: "engineer",
    spriteSeed: "e2e-bo",
    title: "Founding Engineer",
  },
];

interface Founded {
  company: Company;
  employees: Employee[];
  product: Product;
}

/**
 * Found a company over the bridge with a hand-written team, skipping the test when no CLI is
 * signed in (founding picks each hire's CLI). The $0 cap is what keeps it free: the scheduler
 * checks the budget before it spawns anything, so no run can start even on a tick that lands
 * before autopilot is off. The window that founded it never learns of it: relaunch to see it.
 */
export const foundCompany = async (page: Page): Promise<Founded> => {
  const bridge = await bridgeOf(page);
  const auth = await bridge.evaluate((b) => b.hasAuth());
  test.skip(!auth.ok, "no signed-in claude or codex CLI: founding and the office need one");
  return await bridge.evaluate(async (b, hires) => {
    const company = await b.foundCompany({
      budget: { capUsd: 0, mode: "capped" },
      businessType: "custom",
      founderName: "E2E Founder",
      founderSpriteSeed: "e2e-founder",
      hires,
      mission: "Prove the office boots without spending a cent.",
      name: "E2E Test Co",
    });
    await b.setAutopilot({ running: false });
    const [product] = await b.listProducts();
    if (!product) {
      throw new Error("a founded company has no product");
    }
    return { company, employees: await b.listEmployees(), product };
  }, HIRES);
};

const secretsFile = (root: string): string => path.join(root, "secrets.json");

/** secrets.json as written, to look for a key in plain text anywhere in it. */
export const secretsText = (root: string): Promise<string> => readFile(secretsFile(root), "utf-8");

export const readSecrets = async (root: string): Promise<JsonRecord> =>
  jsonRecordSchema.parse(parseJson(await secretsText(root)));

export const writeSecrets = (root: string, secrets: JsonRecord): Promise<void> =>
  writeFile(secretsFile(root), JSON.stringify(secrets, null, 2), { mode: 0o600 });

/** What main gets for one call in place of the API's answer. */
interface Canned {
  host: string;
  route: string;
  /** JSON text: a JSON value is too deep for the type of evaluate's argument. */
  body: string;
}

const canned = (host: string, route: string, body: JsonValue): Canned => ({
  body: JSON.stringify(body),
  host,
  route,
});

const STRIPE = "api.stripe.com";
const VERCEL = "api.vercel.com";
const NOTHING = { data: [], has_more: false, object: "list" };

/** The Stripe and Vercel of an account that takes any key: one project, no money, no visitors. */
const CANNED_APIS: Canned[] = [
  canned(STRIPE, "/v1/charges", NOTHING),
  canned(STRIPE, "/v1/customers", NOTHING),
  canned(STRIPE, "/v1/customers/search", { ...NOTHING, object: "search_result", total_count: 0 }),
  canned(STRIPE, "/v1/payment_links", NOTHING),
  canned(VERCEL, "/v1/query/web-analytics/visits/count", { data: { visitors: 0 } }),
  canned(VERCEL, "/v2/teams", { teams: [] }),
  canned(VERCEL, "/v2/user", { user: { username: "e2e" } }),
  canned(VERCEL, "/v6/deployments", { deployments: [] }),
  canned(VERCEL, "/v9/projects", { projects: [{ id: "prj_e2e", name: "e2e-tip-jar" }] }),
];

/**
 * Answer main's calls to Stripe and Vercel from `CANNED_APIS` for the rest of this launch, so a
 * key being taken is tested with no real account; a route it lacks gets a 404, never the real
 * service. Main reads the global `fetch` on every request, so swapping it reaches them all.
 */
export const stubStripeAndVercel = (app: ElectronApplication): Promise<void> =>
  app.evaluate((_electronModule, answers) => {
    const real = globalThis.fetch;
    const stub = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (!answers.some((answer) => answer.host === url.host)) {
        return real(input, init);
      }
      const found = answers.find(
        (answer) => answer.host === url.host && answer.route === url.pathname,
      );
      const headers = { "content-type": "application/json" };
      return Promise.resolve(
        found === undefined
          ? new Response("{}", { headers, status: 404 })
          : new Response(found.body, { headers }),
      );
    };
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: stub, writable: true });
  }, CANNED_APIS);
