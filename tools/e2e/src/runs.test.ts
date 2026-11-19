import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { PersistedActivity } from "@repo/domain/activity";
import { businessTypeById } from "@repo/domain/domain";
import { usageLabel } from "@repo/domain/format";
import type { HireCandidate } from "@repo/domain/hire";
import { RUNNER_IDS } from "@repo/domain/runners";
import type { Usage } from "idlebiz/stand-in-model";
import {
  apiOf,
  expect,
  foundCompany,
  keyShot,
  loggedActivity,
  sandboxedRunsOrSkip,
  test,
} from "./harness";
import type { Founded } from "./harness";
import { NPCS_IN_OFFICE, NPC_ACTIVITY, STEP_OFFICE } from "./office-probe";

const A_RUN = 90_000;

test.describe.configure({ mode: "parallel", timeout: 2 * A_RUN + 120_000 });

type Api = Awaited<ReturnType<typeof apiOf>>;

type RunEnd = Extract<PersistedActivity, { kind: "run.end" }>;

const USAGE: Usage = { input: 10_000, output: 1000 };

const CAP_USD = 5;

const isRunEnd = (row: PersistedActivity): row is RunEnd => row.kind === "run.end";

const sole = <T>(items: readonly T[], what: string) => {
  const [item] = items;

  if (items.length !== 1 || item === undefined) {
    throw new Error(`expected one ${what}, found ${items.length}`);
  }

  return item;
};

const engineerOf = ({ company, employees }: Founded) => {
  const engineer = employees.find((e) => e.id !== company.leaderId);

  if (!engineer) {
    throw new Error("the founded company has only its lead");
  }

  return engineer;
};

const raiseTheCap = async (api: Api) => {
  const waiting = await api.tasks.list({ status: ["todo", "queued", "running"] });
  expect(waiting, "nothing waits to run when the cap goes up").toEqual([]);
  const company = await api.company.setBudget({ budget: { capUsd: CAP_USD, mode: "capped" } });
  expect(company.autopilot, "autopilot stays off").toBe(false);
};

const runsEnded = async (root: string, count: number) => {
  const ended = async () => {
    const rows = await loggedActivity(root);

    return rows.filter(isRunEnd);
  };

  await expect.poll(ended, { message: `${count} runs ended`, timeout: A_RUN }).toHaveLength(count);

  return await ended();
};

const teamLine = (page: Page, text: string) =>
  page
    .locator(".px-window")
    .filter({ hasText: "# team" })
    .locator(".px-scroll")
    .first()
    .locator(":scope > div")
    .filter({ hasText: text });

const RUN_STEPS = new Set(["run.start", "tool_call", "ship", "run.end"]);

const stepsOf = (rows: readonly PersistedActivity[], runId: string, employeeId: string) =>
  rows.flatMap((row) => {
    if (row.kind === "chat") {
      const { from } = row.payload;

      return from.kind === "employee" && from.id === employeeId ? [row.kind] : [];
    }

    return "runId" in row && row.runId === runId && RUN_STEPS.has(row.kind) ? [row.kind] : [];
  });

const literally = (text: string) => text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

const turnPagesUntil = async (page: Page, shown: Locator) => {
  await expect(async () => {
    if (!(await shown.isVisible())) {
      await page.keyboard.press("Enter");
    }

    await expect(shown).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: A_RUN });
};

const choose = async (page: Page, label: string) => {
  const item = page
    .locator(".ob-menu .px-menu-item")
    .filter({ hasText: new RegExp(`${literally(label)}\\s*$`, "u") });

  const skip = page.getByRole("button", { name: "skip ▸" });
  await expect(async () => {
    if (await skip.isVisible()) {
      await page.keyboard.press("Tab");
    }

    await expect(item).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: A_RUN });
  await item.click();
};

const SAID = "stand-in says hi";
const LAST_WORD = "Tidied the README.";

const KEYS = {
  printful: "pf_e2e_vault_token_7310",
  stripe: "sk_test_e2eCustody7310",
  vercel: "vercel_e2e_vault_token",
};

const COMPANY = "E2E Stand-in Co";

const CAST: HireCandidate[] = [
  {
    blurb: "Picks the bet and hands out the work.",
    name: "Rae Lund",
    persona: "A decisive general manager who bets the team's time on the real numbers.",
    role: "lead",
    title: "General Manager",
  },
  {
    blurb: "Ships small, working slices.",
    name: "Tomas Ruiz",
    persona: "A founding engineer who ships a small, working slice every day.",
    role: "engineer",
    title: "Founding Engineer",
  },
  {
    blurb: "Finds the first buyers by hand.",
    name: "Ivy Okafor",
    persona: "A growth marketer who finds the first buyers one conversation at a time.",
    role: "marketer",
    title: "Growth Marketer",
  },
];

for (const runner of RUNNER_IDS) {
  test.describe(`on ${runner}`, () => {
    test.use({ runners: [runner] });

    test.describe("one run", () => {
      test.use({ runs: 1 });

      test("a directed employee runs one sandboxed turn and its line reaches #team", async ({
        launch,
        model,
        root,
      }) => {
        const founding = await launch();
        const founded = await foundCompany(founding.page);
        await founding.close();
        const engineer = engineerOf(founded);
        const marker = "E2E-RUN-1";
        model.script(
          marker,
          [
            { command: `idlebiz message-team '${JSON.stringify({ text: SAID })}'`, kind: "shell" },
            { kind: "hold" },
            { kind: "say", text: LAST_WORD },
          ],
          USAGE,
        );

        const { page } = await launch();
        const api = await apiOf(page);
        await expect.poll(() => page.evaluate(NPCS_IN_OFFICE)).toBe(founded.employees.length);
        await raiseTheCap(api);
        await api.employees.direct({
          employeeId: engineer.id,
          instruction: `${marker} tidy the README`,
        });

        await expect
          .poll(() => model.toolOutputs(marker).join("\n"), { timeout: A_RUN })
          .toContain("Posted to the team room.");
        await expect.poll(() => page.evaluate(NPC_ACTIVITY(engineer.id))).toBe("working");
        await expect(page.getByRole("button", { name: /team/iu })).toContainText("1 working");
        await expect(teamLine(page, SAID)).toContainText(engineer.name);

        const running = async () => {
          const tasks = await api.tasks.list({ status: ["running"] });

          return tasks.map((t) => t.assigneeId);
        };

        await expect.poll(running).toEqual([engineer.id]);
        await page.evaluate(STEP_OFFICE);
        await keyShot(page, `run-working-${runner}`);

        model.release();
        const end = sole(await runsEnded(root, 1), "run end");
        expect(end.payload).toMatchObject({
          outcome: { kind: "done" },
          settled: "done",
          summary: LAST_WORD,
        });
        await expect.poll(() => page.evaluate(NPC_ACTIVITY(engineer.id))).toBe("idle");
        await expect(teamLine(page, `shipped: ${LAST_WORD}`)).toContainText(`📦 ${engineer.name}`);

        const shipped = async () => {
          const log = await api.tasks.shipped();

          return log.map(({ summary }) => summary);
        };

        await expect.poll(shipped).toContain(LAST_WORD);

        const steps = stepsOf(await loggedActivity(root), end.runId, engineer.id);
        expect(steps.at(0)).toBe("run.start");
        expect(steps.slice(1, -2).toSorted()).toEqual(["chat", "tool_call"]);
        expect(steps.slice(-2)).toEqual(["ship", "run.end"]);

        expect(end.payload.costUsd).toBeGreaterThan(0);
        const company = await api.company.get();

        if (company === null) {
          throw new Error("the company is gone");
        }

        expect(company.spentUsd).toBe(Math.round(end.payload.costUsd * 10_000) / 10_000);
        await expect(page.getByRole("button", { name: /revenue/iu })).toContainText(
          usageLabel(company.spentUsd),
        );
      });

      test("the sandbox and the vault hold inside a run", async ({ launch, model, root }) => {
        const founding = await launch();
        const founded = await foundCompany(founding.page);
        await founding.close();
        const engineer = engineerOf(founded);
        const vault = path.join(root, "vault.json");
        const planted = path.join(root, "company", "written-by-a-run");
        const marker = "E2E-SANDBOX-1";
        model.script(
          marker,
          [
            {
              command: `cat '${vault}'; touch '${planted}'; env | tee run-env.txt`,
              kind: "shell",
            },
            { kind: "say", text: "Looked around." },
          ],
          USAGE,
        );

        const { page } = await launch();
        const api = await apiOf(page);
        await api.stripe.saveKey({ key: KEYS.stripe });
        await api.vercel.saveToken({ productId: founded.product.id, token: KEYS.vercel });
        await api.printful.saveToken({ token: KEYS.printful });
        await raiseTheCap(api);
        await api.employees.direct({
          employeeId: engineer.id,
          instruction: `${marker} look around the save`,
        });
        const end = sole(await runsEnded(root, 1), "run end");
        expect(end.payload.outcome).toEqual({ kind: "done" });

        const output = model.toolOutputs(marker).join("\n");
        expect(output).toMatch(/vault\.json: Operation not permitted/u);
        expect(output).toMatch(/written-by-a-run: Operation not permitted/u);
        expect(existsSync(planted)).toBe(false);

        const runEnv = await readFile(
          path.join(founded.product.workspaceDir, "run-env.txt"),
          "utf-8",
        );

        expect(runEnv, "the env written is the run's").toContain("IDLEBIZ_API_SOCKET=");
        const reached = [runEnv, output, ...model.requests.map(({ body }) => body)];
        expect(
          Object.entries(KEYS)
            .filter(([, value]) => reached.some((text) => text.includes(value)))
            .map(([k]) => k),
          "no saved key reached the run or the model",
        ).toEqual([]);
      });
    });

    test.describe("autopilot's runs", () => {
      test.use({ runs: "settled" });

      test("a company founded through the page is cast on the stand-in, and autopilot's first run settles", async ({
        launch,
        model,
        root,
      }) => {
        model.hires(null, CAST);
        const office = await launch();
        const { page } = office;
        await sandboxedRunsOrSkip(page);
        await page.emulateMedia({ reducedMotion: "reduce" });

        await page.getByRole("button", { name: "Start your company" }).click();
        const founder = page.getByPlaceholder("Ada");
        await turnPagesUntil(page, founder);
        await founder.fill("E2E Founder");
        await founder.press("Enter");
        await choose(page, "That's me");
        const company = page.getByPlaceholder("Acme AI");
        await company.fill(COMPANY);
        await company.press("Enter");
        await choose(page, businessTypeById("custom").label);
        const pitch = page.locator("textarea.ob-field");
        await pitch.fill("A tip jar for indie developers.");
        await pitch.press("Enter");
        await choose(page, "Sign them");
        await choose(page, "$5");

        await expect(page.getByText("# team")).toBeVisible();
        await expect.poll(() => page.evaluate(NPCS_IN_OFFICE)).toBe(CAST.length);
        await page.evaluate(STEP_OFFICE);
        await keyShot(page, `onboarded-${runner}`);

        await expect
          .poll(
            async () => {
              const rows = await loggedActivity(root);
              const ends = rows.filter(isRunEnd);
              const started = rows.filter((row) => row.kind === "run.start").length;

              return ends.length === started && ends.some((e) => e.payload.outcome.kind === "done");
            },
            {
              message: "autopilot's first run ended done, and no other is in flight",
              timeout: A_RUN,
            },
          )
          .toBe(true);
        const api = await apiOf(page);
        const founded = await api.company.get();

        if (founded === null) {
          throw new Error("onboarding founded no company");
        }

        expect(founded).toMatchObject({ autopilot: true, budget: { capUsd: 5, mode: "capped" } });
        expect(founded.spentUsd).toBeLessThan(5);
        await office.close();
      });
    });
  });
}
