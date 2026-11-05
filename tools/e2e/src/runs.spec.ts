import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { PersistedActivity } from "@repo/domain/activity";
import { businessTypeById } from "@repo/domain/domain";
import type { Employee } from "@repo/domain/domain";
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
  readSecrets,
  sealedRunsOrSkip,
  test,
} from "./harness";
import type { Founded } from "./harness";
import { INBOX_BUTTON, NPCS_IN_OFFICE, NPC_ACTIVITY, STEP_OFFICE } from "./office-probe";

// The run loop end to end, once on each runner: the claude or codex its adapter bundles runs real
// turns sealed, which the stand-in model scripts (harness.ts), through the company's own tool, the
// seal, the founder's sign-off and onboarding. A test founds at $0 with autopilot off and raises
// the cap itself, so only the work it directs runs, and the root fixture holds it to the runs it
// scripts: each ended, none failed, none signed in but the stand-in's.

/** How long a sealed CLI may take to start and reach a scripted step, or end, on a loaded Mac. */
const A_RUN = 90_000;

// a test waits on two runs one after the other at most, each up to A_RUN, beside a founding, two
// launches and a quit: two minutes more covers those on a Mac running two tests at once
test.describe.configure({ mode: "parallel", timeout: 2 * A_RUN + 120_000 });

type Api = Awaited<ReturnType<typeof apiOf>>;
type RunEnd = Extract<PersistedActivity, { kind: "run.end" }>;

/** What each scripted answer reports using: enough to show on the HUD, far under the cap. */
const USAGE: Usage = { input: 10_000, output: 1000 };

/** The cap a test raises founding's $0 to, so the work it directs can start. */
const CAP_USD = 5;

const isRunEnd = (row: PersistedActivity): row is RunEnd => row.kind === "run.end";

/** The one item of `items`, or a throw naming what was counted. */
const sole = <T>(items: readonly T[], what: string): T => {
  const [item] = items;
  if (items.length !== 1 || item === undefined) {
    throw new Error(`expected one ${what}, found ${items.length}`);
  }
  return item;
};

/** The founding team's engineer, who takes the work a test directs. */
const engineerOf = ({ company, employees }: Founded): Employee => {
  const engineer = employees.find((e) => e.id !== company.leaderId);
  if (!engineer) {
    throw new Error("the founded company has only its lead");
  }
  return engineer;
};

/**
 * Raises the cap from founding's $0, which with autopilot off and nothing queued starts nothing:
 * the scheduler only drains the queue (`tick`), and only autopilot files a bet's work, a proposal
 * or a routine (`tickAutopilot`), so what the test directs next is the only work there is.
 */
const raiseTheCap = async (api: Api): Promise<void> => {
  const waiting = await api.tasks.list({ status: ["todo", "queued", "running"] });
  expect(waiting, "nothing waits to run when the cap goes up").toEqual([]);
  const company = await api.company.setBudget({ budget: { capUsd: CAP_USD, mode: "capped" } });
  expect(company.autopilot, "autopilot stays off").toBe(false);
};

/** Each run `root` logged ending, in order, once `count` have. */
const runsEnded = async (root: string, count: number): Promise<RunEnd[]> => {
  const ended = async (): Promise<RunEnd[]> => {
    const rows = await loggedActivity(root);
    return rows.filter(isRunEnd);
  };
  await expect.poll(ended, { message: `${count} runs ended`, timeout: A_RUN }).toHaveLength(count);
  return await ended();
};

/** The line of #team that says `text`, as the founder reads it. */
const teamLine = (page: Page, text: string): Locator =>
  page
    .locator(".px-window")
    .filter({ hasText: "# team" })
    .locator(".px-scroll")
    .first()
    .locator(":scope > div")
    .filter({ hasText: text });

/** What a run logs that says how its turn went, of all it logs (its statuses, its prose). */
const RUN_STEPS = new Set(["run.start", "tool_call", "ship", "run.end"]);

/** What run `runId` logged, by kind and in order, beside the room lines `employeeId` posted. */
const stepsOf = (rows: readonly PersistedActivity[], runId: string, employeeId: string): string[] =>
  rows.flatMap((row) => {
    if (row.kind === "chat") {
      const { from } = row.payload;
      return from.kind === "employee" && from.id === employeeId ? [row.kind] : [];
    }
    return "runId" in row && row.runId === runId && RUN_STEPS.has(row.kind) ? [row.kind] : [];
  });

/** `text` as a regular expression matches it, character for character. */
const literally = (text: string): string =>
  text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

/** Turns Chad's pages with Enter, the founder's A button, until `shown` is up. */
const turnPagesUntil = async (page: Page, shown: Locator): Promise<void> => {
  await expect(async () => {
    if (!(await shown.isVisible())) {
      await page.keyboard.press("Enter");
    }
    await expect(shown).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: A_RUN });
};

/**
 * Picks `label` from the choice window under Chad's last page, skipping his pages to it with Tab,
 * the founder's key for `skip ▸`: on CI's Mac the link itself never held still long enough to be
 * clicked.
 */
const choose = async (page: Page, label: string): Promise<void> => {
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

/** What the employee's run says in #team, through the company's own tool. */
const SAID = "stand-in says hi";
const LAST_WORD = "Tidied the README.";

/** IdleBiz's keys, as the founder enters them: stub-services takes each. */
const KEYS = {
  printful: "pf_e2e_custody_token_7310",
  stripe: "sk_test_e2eCustody7310",
  vercel: "vercel_e2e_custody_token",
};

/** A push the hold rules sign off one run of, to a remote no workspace has. */
const PUSH = "git push origin main";

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

      test("a directed employee runs one sealed turn and its line reaches #team", async ({
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

        // held before its last word: the turn is under way, and the company's tool answered it
        await expect
          .poll(() => model.toolOutputs(marker).join("\n"), { timeout: A_RUN })
          .toContain("Posted to the team room.");
        await expect.poll(() => page.evaluate(NPC_ACTIVITY(engineer.id))).toBe("working");
        await expect(page.getByRole("button", { name: /team/iu })).toContainText("1 working");
        await expect(teamLine(page, SAID)).toContainText(engineer.name);
        const running = async (): Promise<(string | null)[]> => {
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
        const shipped = async (): Promise<string[]> => {
          const log = await api.tasks.shipped();
          return log.map(({ summary }) => summary);
        };
        await expect.poll(shipped).toContain(LAST_WORD);

        // codex announces a command as it starts, so its call and the line it posts may log in
        // either order; both land inside the run, before what it shipped
        const steps = stepsOf(await loggedActivity(root), end.runId, engineer.id);
        expect(steps.at(0)).toBe("run.start");
        expect(steps.slice(1, -2).toSorted()).toEqual(["chat", "tool_call"]);
        expect(steps.slice(-2)).toEqual(["ship", "run.end"]);

        // priced as its CLI or the runner's rates price it, never a fixed amount: the one run is
        // the whole spend, which the store keeps to the hundredth of a cent
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

      test("the seal and custody hold inside a run", async ({ launch, model, root }) => {
        const founding = await launch();
        const founded = await foundCompany(founding.page);
        await founding.close();
        const engineer = engineerOf(founded);
        const secrets = path.join(root, "secrets.json");
        const planted = path.join(root, "company", "written-by-a-run");
        const marker = "E2E-SEAL-1";
        model.script(
          marker,
          [
            {
              command: `cat '${secrets}'; touch '${planted}'; env | tee run-env.txt`,
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
        const held = await readSecrets(root);
        const sealed = [held.STRIPE_SECRET_KEY, held.VERCEL_TOKEN, held.PRINTFUL_TOKEN].filter(
          (value): value is string => typeof value === "string" && value.startsWith("sealed:v2:"),
        );
        expect(sealed, "each key is kept sealed").toHaveLength(3);
        await raiseTheCap(api);
        await api.employees.direct({
          employeeId: engineer.id,
          instruction: `${marker} look around the save`,
        });
        const end = sole(await runsEnded(root, 1), "run end");
        expect(end.payload.outcome).toEqual({ kind: "done" });

        // the seal: the keys' file unreadable, the save unwritable but for the run's own folders
        const output = model.toolOutputs(marker).join("\n");
        expect(output).toMatch(/secrets\.json: Operation not permitted/u);
        expect(output).toMatch(/written-by-a-run: Operation not permitted/u);
        expect(existsSync(planted)).toBe(false);

        // custody: the env the run's shell had holds no key, and no request to the model carried
        // one, as entered or as sealed
        const runEnv = await readFile(
          path.join(founded.product.workspaceDir, "run-env.txt"),
          "utf-8",
        );
        expect(runEnv, "the env written is the run's").toContain("IDLEBIZ_API_SOCKET=");
        const reached = [runEnv, output, ...model.requests.map(({ body }) => body)];
        const keys = [
          ...Object.entries(KEYS),
          ...sealed.map((value, i): [string, string] => [`sealed key ${i + 1}`, value]),
        ];
        expect(
          keys.filter(([, value]) => reached.some((text) => text.includes(value))).map(([k]) => k),
          "no saved key reached the run or the model",
        ).toEqual([]);
      });
    });

    test.describe("two runs", () => {
      test.use({ runs: 2 });

      test("a held command waits for the founder, whose sign-off runs it once", async ({
        launch,
        model,
        root,
      }) => {
        const founding = await launch();
        const founded = await foundCompany(founding.page);
        await founding.close();
        const engineer = engineerOf(founded);
        const marker = "E2E-HOLD-1";
        model.script(marker, [{ command: PUSH, kind: "shell" }], USAGE);

        const { page } = await launch();
        const api = await apiOf(page);
        await raiseTheCap(api);
        await api.employees.direct({
          employeeId: engineer.id,
          instruction: `${marker} publish the README`,
        });

        // holdFor holds the push, so the first run ends waiting on the founder
        const asked = sole(await runsEnded(root, 1), "run end");
        const ask = { command: PUSH, rule: "git-push", type: "approval" };
        expect(asked.payload).toMatchObject({
          outcome: { ask, kind: "blocked" },
          settled: "blocked",
        });
        await expect.poll(() => page.evaluate(NPC_ACTIVITY(engineer.id))).toBe("blocked");

        await page.getByTitle(INBOX_BUTTON).click();
        const inbox = page.getByRole("dialog", { name: "Inbox" });
        await expect(inbox.getByText(PUSH)).toBeVisible();
        await keyShot(page, `run-held-${runner}`);
        await inbox.getByRole("button", { name: "Approve" }).click();
        await expect(inbox.getByText(PUSH)).toHaveCount(0);

        // signed, the same push runs once: git's own answer, from a workspace with no remote and,
        // before the team's first commit, no `main` either
        const [, signed] = await runsEnded(root, 2);
        expect(signed?.payload).toMatchObject({ outcome: { kind: "done" }, settled: "done" });
        expect(model.toolOutputs(marker).at(-1)).toMatch(
          /src refspec main does not match any|'origin' does not appear to be a git repository/u,
        );
        const git = await readFile(
          path.join(founded.product.workspaceDir, ".git", "config"),
          "utf-8",
        );
        expect(git, "the workspace has no remote to push to").not.toContain("[remote");
      });
    });

    test.describe("autopilot's runs", () => {
      test.use({ runs: "settled" });

      test("a company founded through the page is cast on the stand-in, and autopilot's first run settles", async ({
        launch,
        model,
        root,
      }) => {
        // casting alone gets CAST: a run's brief names the company too, and is told "done"
        model.hires(null, CAST);
        const office = await launch();
        const { page } = office;
        await sealedRunsOrSkip(page);
        // each of Chad's pages whole at once, so a step waits on nothing but what it asks
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
        // casting is a turn of the runner's CLI, sealed, which the stand-in answers with CAST
        await choose(page, "Sign them");
        // CAPS offers no $0, and autopilot is on from founding
        await choose(page, "$5");

        await expect(page.getByText("# team")).toBeVisible();
        await expect.poll(() => page.evaluate(NPCS_IN_OFFICE)).toBe(CAST.length);
        await page.evaluate(STEP_OFFICE);
        await keyShot(page, `onboarded-${runner}`);

        // autopilot's first tick sends the lead to propose; the stand-in ends it at once
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
