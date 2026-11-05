import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { startDevHost } from "idlebiz/dev-host";
import { startStandInModel } from "idlebiz/stand-in-model";
import type { StandInModel } from "idlebiz/stand-in-model";
import { isProviderEnv, standInRunnerEnv } from "idlebiz/stand-in-runners";
import { PersistedActivitySchema } from "@repo/domain/activity";
import type { Company, Employee, Product } from "@repo/domain/domain";
import type { HireProposal } from "@repo/domain/hire";
import type { RunnerId } from "@repo/domain/runners";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { Contract } from "@repo/contract/contract";
import { RPC_PREFIX } from "@repo/contract/routes";
import { jsonRecordSchema, parseJson } from "@repo/domain/json";
import type { JsonRecord, JsonValue } from "@repo/domain/json";

/** The page's API, as the page calls it. */
type Api = ContractRouterClient<Contract>;

interface Launched {
  page: Page;
  /** Closes the page and quits main as the app's Quit does; the next launch starts fresh. */
  close: () => Promise<void>;
}

/** How the Stripe and Vercel main calls answer a key: they take any, or turn every one away. */
type Keys = "taken" | "refused";

interface LaunchOptions {
  /** Taken unless a test says otherwise; main reaches no real service either way. */
  keys?: Keys;
}

interface Options {
  /**
   * The CLIs every launch finds signed in, each the one its adapter bundles, on `model`: both unless
   * a test says otherwise, and none keeps the signed-out path.
   */
  runners: readonly RunnerId[];
  /** How many runs the test scripts, each of which must start and end: none unless it says so. */
  runs: number;
}

interface Fixtures {
  /** The model every run of this test reaches, on loopback, and nothing else does. */
  model: StandInModel;
  /** Main's env for `runners` signed in to `model`, in homes of their own outside the save. */
  standIn: Record<string, string>;
  /** A fresh save root for this test, deleted after it. */
  root: string;
  /**
   * Start the built main on `root` and open the page it serves in Chromium, signed in by a handoff
   * as the shell's window is; whatever is still open closes when the test ends.
   */
  launch: (options?: LaunchOptions) => Promise<Launched>;
}

/** Each run the company on `root` logged starting, and each it logged ending, by id. */
const runsLogged = async (root: string): Promise<{ started: string[]; ended: string[] }> => {
  const log = path.join(root, "company", "activity.jsonl");
  if (!existsSync(log)) {
    return { ended: [], started: [] };
  }
  const lines = await readFile(log, "utf-8");
  const rows = lines
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => PersistedActivitySchema.parse(parseJson(line)));
  return {
    ended: rows.flatMap((row) => (row.kind === "run.end" ? [row.runId] : [])),
    started: rows.flatMap((row) => (row.kind === "run.start" ? [row.runId] : [])),
  };
};

/** What main gets for one call in place of the API's answer (stub-services.ts). */
interface Canned {
  host: string;
  route: string;
  status: number;
  /** The answer's JSON text. */
  body: string;
}

const canned = (host: string, route: string, body: JsonValue, status = 200): Canned => ({
  body: JSON.stringify(body),
  host,
  route,
  status,
});

const STRIPE = "api.stripe.com";
const VERCEL = "api.vercel.com";
const PRINTFUL = "api.printful.com";
const NOTHING = { data: [], has_more: false, object: "list" };

/**
 * The Stripe, Vercel and Printful of an account that takes any key: one project, no money, no
 * visitors, one store that may place orders.
 */
const TAKING: readonly Canned[] = [
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

/** What Stripe and Vercel answer a key they never issued, with a 401. */
const STRIPE_REFUSAL = {
  error: { message: "Invalid API Key provided", type: "invalid_request_error" },
};
const VERCEL_REFUSAL = { error: { code: "forbidden", message: "Not authorized" } };

/** TAKING, but each Stripe and Vercel call turned away. */
const REFUSING: readonly Canned[] = TAKING.map((answer) => {
  if (answer.host === STRIPE) {
    return canned(STRIPE, answer.route, STRIPE_REFUSAL, 401);
  }
  if (answer.host === VERCEL) {
    return canned(VERCEL, answer.route, VERCEL_REFUSAL, 401);
  }
  return answer;
});

const ANSWERS: Record<Keys, readonly Canned[]> = { refused: REFUSING, taken: TAKING };

// loaded into main before its own code, by every launch: it answers from ANSWERS
const STUB_SERVICES = fileURLToPath(new URL("stub-services.ts", import.meta.url));

const start = async (
  root: string,
  browser: Browser,
  options: LaunchOptions,
  standIn: Readonly<Record<string, string>>,
  log: (line: string) => void,
): Promise<Launched> => {
  const host = await startDevHost({
    env: { IDLEBIZ_E2E_CANNED: JSON.stringify(ANSWERS[options.keys ?? "taken"]), ...standIn },
    // the terminal's own logins stay out, so a run reaches the stand-in or nothing
    inherit: (name) => !isProviderEnv(name),
    log,
    nodeArgs: ["--import", STUB_SERVICES],
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
    return { close, page };
  } catch (error) {
    // a launch that failed part way leaks nothing it made: the context, main
    await close();
    throw error;
  }
};

export const test = base.extend<Fixtures & Options>({
  launch: async ({ browser, root, standIn }, provide, testInfo) => {
    const open: Launched[] = [];
    const lines: string[] = [];
    await provide(async (options = {}) => {
      const launched = await start(root, browser, options, standIn, (line) => {
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
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern; the model has none
  model: async ({}, provide) => {
    const model = await startStandInModel();
    try {
      await provide(model);
    } finally {
      await model.close();
    }
  },
  // torn down after every launch, so each main has stopped its runs before the save is read
  root: async ({ model, runs }, provide) => {
    const root = await mkdtemp(path.join(tmpdir(), "idlebiz-e2e-"));
    try {
      await provide(root);
      const { ended, started } = await runsLogged(root);
      expect(started, `only the runs the test scripts start: ${runs}`).toHaveLength(runs);
      expect(ended.toSorted(), "every run that started ended").toEqual(started.toSorted());
      expect(model.leaks, "no login but the stand-in's reached the model").toEqual([]);
      expect(model.unexpected, "the model was asked nothing it does not answer").toEqual([]);
      if (runs === 0) {
        const turns = model.requests.filter(
          ({ protocol }) => protocol === "messages" || protocol === "responses",
        );
        expect(
          turns.map(({ path: asked }) => asked),
          "a test that runs nothing asks the model nothing",
        ).toEqual([]);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
  runners: [["claude", "codex"], { option: true }],
  runs: [0, { option: true }],
  standIn: async ({ model, runners }, provide) => {
    // outside the save, which a run's seal closes to it
    const scratch = await mkdtemp(path.join(tmpdir(), "idlebiz-e2e-runners-"));
    try {
      await provide(await standInRunnerEnv({ model, runners, scratch }));
    } finally {
      await rm(scratch, { force: true, recursive: true });
    }
  },
});

export { expect } from "@playwright/test";

/**
 * The page's API to the server, called from the test with what main asks of every call: the
 * cookie the page's handoff set, from the page's own origin.
 */
export const apiOf = async (page: Page): Promise<Api> => {
  const { origin } = new URL(page.url());
  const cookies = await page.context().cookies(origin);
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  return createORPCClient(new RPCLink({ headers: { cookie, origin }, origin, url: RPC_PREFIX }));
};

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

/** Where claude keeps the managed settings that outrank every other tier of its own. */
const CLAUDE_MANAGED = "/Library/Application Support/ClaudeCode";

/** Whether this Mac's claude has managed settings, whose env or key helper outrank the stand-in's. */
const claudeManaged = (): boolean =>
  ["managed-settings.json", "managed-settings.d"].some((name) =>
    existsSync(path.join(CLAUDE_MANAGED, name)),
  );

/**
 * Found a company over the page's API with a hand-written team, on the CLIs the stand-in signs in
 * (founding picks each hire's CLI). Off a Mac no run is sealed, so no CLI is found and the test
 * skips on the seal's own refusal; on a Mac a CLI that does not sign in fails it. The $0 cap is
 * what keeps it free: the scheduler checks the budget before it spawns anything, so no run can
 * start even on a tick that lands before autopilot is off. The window that founded it never
 * learns of it: relaunch to see it.
 */
export const foundCompany = async (page: Page): Promise<Founded> => {
  const api = await apiOf(page);
  // the first report waits on the seal's check, so a refusal is in it
  const report = await api.save.report();
  const sealing = report.skipped.find(({ kind }) => kind === "seal");
  test.skip(process.platform !== "darwin" && sealing !== undefined, sealing?.error);
  test.skip(
    claudeManaged(),
    `claude's managed settings in ${CLAUDE_MANAGED} outrank the stand-in's sign-in on this Mac`,
  );
  const auth = await api.agents.hasAuth();
  expect(
    auth.ok,
    `the stand-in's CLIs did not sign in under the seal: hasAuth ${JSON.stringify(auth)}, the save's report ${JSON.stringify(report)}, and main's log is attached as "main"`,
  ).toBe(true);
  const company = await api.onboarding.found({
    budget: { capUsd: 0, mode: "capped" },
    businessType: "custom",
    founderName: "E2E Founder",
    founderSpriteSeed: "e2e-founder",
    hires: HIRES,
    mission: "Prove the office boots without spending a cent.",
    name: "E2E Test Co",
  });
  await api.company.setAutopilot({ running: false });
  const [product] = await api.products.list();
  if (!product) {
    throw new Error("a founded company has no product");
  }
  return { company, employees: await api.employees.list(), product };
};

const secretsFile = (root: string): string => path.join(root, "secrets.json");

/** secrets.json as written, to look for a key in plain text anywhere in it. */
export const secretsText = (root: string): Promise<string> => readFile(secretsFile(root), "utf-8");

export const readSecrets = async (root: string): Promise<JsonRecord> =>
  jsonRecordSchema.parse(parseJson(await secretsText(root)));

export const writeSecrets = (root: string, secrets: JsonRecord): Promise<void> =>
  writeFile(secretsFile(root), JSON.stringify(secrets, null, 2), { mode: 0o600 });
