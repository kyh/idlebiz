import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";
import type { Browser, BrowserContext, JSHandle, Page } from "@playwright/test";
import { startDevHost } from "idlebiz/dev-host";
import type { DevHost } from "idlebiz/dev-host";
import type { Company, Employee, Product } from "@repo/domain/domain";
import type { HireProposal } from "@repo/domain/hire";
import type { ContractRouterClient } from "@orpc/contract";
import type { Contract } from "@repo/contract/contract";
import { jsonRecordSchema, parseJson } from "@repo/domain/json";
import type { JsonRecord, JsonValue } from "@repo/domain/json";

/** The page's API, as the page calls it. */
type Api = ContractRouterClient<Contract>;

declare global {
  // What the page's install-api.ts sets on the window; its api.ts declares it for the app.
  var appApi: { api: Api } | undefined;
}

interface Launched {
  page: Page;
  /** What main asked the system to open, oldest first: the dev host opens nothing. */
  opened: DevHost["opened"];
  /** Closes the page and quits main as the app's Quit does; the next launch starts fresh. */
  close: () => Promise<void>;
}

interface LaunchOptions {
  /** Answer main's calls to Stripe, Vercel and Printful from `CANNED_APIS`, from its first. */
  stubServices?: boolean;
}

interface Fixtures {
  /** A fresh save root for this test, deleted after it. */
  root: string;
  /**
   * Start the built main on `root` and open the page it serves in Chromium, signed in by a handoff
   * as the shell's window is; whatever is still open closes when the test ends.
   */
  launch: (options?: LaunchOptions) => Promise<Launched>;
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

/** What main gets for one call in place of the API's answer (stub-services.ts). */
interface Canned {
  host: string;
  route: string;
  /** The answer's JSON text. */
  body: string;
}

const canned = (host: string, route: string, body: JsonValue): Canned => ({
  body: JSON.stringify(body),
  host,
  route,
});

const STRIPE = "api.stripe.com";
const VERCEL = "api.vercel.com";
const PRINTFUL = "api.printful.com";
const NOTHING = { data: [], has_more: false, object: "list" };

/**
 * The Stripe, Vercel and Printful of an account that takes any key: one project, no money, no
 * visitors, one store that may place orders.
 */
const CANNED_APIS: Canned[] = [
  canned(STRIPE, "/v1/charges", NOTHING),
  canned(STRIPE, "/v1/payment_links", NOTHING),
  canned(PRINTFUL, "/v2/oauth-scopes", {
    data: [{ name: "View and manage orders", value: "orders" }],
  }),
  canned(PRINTFUL, "/v2/stores", { data: [{ id: 7, name: "E2E Prints", type: "native" }] }),
  canned(VERCEL, "/v1/query/web-analytics/visits/count", { data: { visitors: 0 } }),
  canned(VERCEL, "/v2/teams", { teams: [] }),
  canned(VERCEL, "/v2/user", { user: { username: "e2e" } }),
  canned(VERCEL, "/v6/deployments", { deployments: [] }),
  canned(VERCEL, "/v9/projects", { projects: [{ id: "prj_e2e", name: "e2e-tip-jar" }] }),
];

// loaded into main before its own code: it answers from CANNED_APIS
const STUB_SERVICES = fileURLToPath(new URL("stub-services.ts", import.meta.url));

const start = async (
  root: string,
  browser: Browser,
  options: LaunchOptions,
  log: (line: string) => void,
): Promise<Launched> => {
  const host = await startDevHost({
    env: options.stubServices ? { IDLEBIZ_E2E_CANNED: JSON.stringify(CANNED_APIS) } : {},
    log,
    nodeArgs: options.stubServices ? ["--import", STUB_SERVICES] : [],
    root,
  });
  let context: BrowserContext | null = null;
  let closing: Promise<void> | null = null;
  // each step whatever the one before it did, so a context that will not close still lets main go
  const close = async (): Promise<void> => {
    closing ??= (async () => {
      try {
        await context?.close();
      } finally {
        await host.stop();
      }
    })();
    await closing;
  };
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(await host.handoff());
    return { close, opened: host.opened, page };
  } catch (error) {
    // a launch that failed part way leaks nothing it made: the context, main
    await close();
    throw error;
  }
};

export const test = base.extend<Fixtures>({
  launch: async ({ browser, root }, provide, testInfo) => {
    const open: Launched[] = [];
    const lines: string[] = [];
    await provide(async (options = {}) => {
      const launched = await start(root, browser, options, (line) => {
        lines.push(line);
      });
      open.push(launched);
      return launched;
    });
    for (const launched of open) {
      await launched.close();
    }
    await testInfo.attach("main", { body: lines.join("\n"), contentType: "text/plain" });
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

/** The page's API to the server, called as the page calls it. */
export const apiOf = (page: Page): Promise<JSHandle<Api>> =>
  page.evaluateHandle(() => {
    const app = globalThis.appApi;
    if (!app) {
      throw new Error("the page installed no API");
    }
    return app.api;
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

export interface Founded {
  company: Company;
  employees: Employee[];
  product: Product;
}

/**
 * Found a company over the page's API with a hand-written team, skipping the test when no CLI is
 * signed in (founding picks each hire's CLI). The $0 cap is what keeps it free: the scheduler
 * checks the budget before it spawns anything, so no run can start even on a tick that lands
 * before autopilot is off. The window that founded it never learns of it: relaunch to see it.
 */
export const foundCompany = async (page: Page): Promise<Founded> => {
  const api = await apiOf(page);
  const auth = await api.evaluate((a) => a.agents.hasAuth());
  test.skip(!auth.ok, "no signed-in claude or codex CLI: founding and the office need one");
  return await api.evaluate(async (a, hires) => {
    const company = await a.onboarding.found({
      budget: { capUsd: 0, mode: "capped" },
      businessType: "custom",
      founderName: "E2E Founder",
      founderSpriteSeed: "e2e-founder",
      hires,
      mission: "Prove the office boots without spending a cent.",
      name: "E2E Test Co",
    });
    await a.company.setAutopilot({ running: false });
    const [product] = await a.products.list();
    if (!product) {
      throw new Error("a founded company has no product");
    }
    return { company, employees: await a.employees.list(), product };
  }, HIRES);
};

const secretsFile = (root: string): string => path.join(root, "secrets.json");

/** secrets.json as written, to look for a key in plain text anywhere in it. */
export const secretsText = (root: string): Promise<string> => readFile(secretsFile(root), "utf-8");

export const readSecrets = async (root: string): Promise<JsonRecord> =>
  jsonRecordSchema.parse(parseJson(await secretsText(root)));

export const writeSecrets = (root: string, secrets: JsonRecord): Promise<void> =>
  writeFile(secretsFile(root), JSON.stringify(secrets, null, 2), { mode: 0o600 });
