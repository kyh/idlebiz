import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bridgeOf, closeFully, expect, foundCompany, test } from "./harness";
import type { Page } from "@playwright/test";
import { z } from "zod";
import type { Founded } from "./harness";

// `npcs` is private to the scene and the manager; the string reaches them at runtime.
const NPCS_IN_OFFICE = `window.__game?.scene.getScene("office")?.npcs?.npcs.size ?? -1`;

const HELD_COMMAND = "deploy tip-jar to production";

test("a founded company boots into the office", async ({ launch }) => {
  const founding = await launch();
  const { employees } = await foundCompany(founding.page);
  await closeFully(founding.app);

  const { page } = await launch();
  for (const plate of [/revenue/iu, /users/iu, /product/iu, /team/iu]) {
    await expect(page.getByRole("button", { name: plate })).toBeVisible();
  }
  await expect(page.getByText("# team")).toBeVisible();
  await expect.poll(() => page.evaluate(NPCS_IN_OFFICE)).toBe(employees.length);
});

const INBOX_BUTTON = "Questions, steps only you can take and stuck tasks waiting on you";

/** A task of the lead's, left blocked on `ask` as TASK.md stores it, for the next launch to load. */
const blockLead = async (
  root: string,
  { company, product }: Founded,
  slug: string,
  ask: string,
): Promise<void> => {
  const taskDir = path.join(root, company.id, "tasks", slug);
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    path.join(taskDir, "TASK.md"),
    [
      "---",
      'kind: "task"',
      'name: "Ship the tip jar"',
      'schema: "agentcompanies/v1"',
      `slug: ${JSON.stringify(slug)}`,
      "metadata:",
      `  createdAt: ${Date.now()}`,
      '  origin: "founder"',
      '  priority: "high"',
      '  status: "blocked"',
      `  assigneeId: ${JSON.stringify(company.leaderId)}`,
      `  productId: ${JSON.stringify(product.id)}`,
      `  blockedQuestion: ${JSON.stringify(ask)}`,
      "---",
      "Ship the tip jar.",
      "",
    ].join("\n"),
  );
};

test("a held command waits in #team and the inbox until the founder denies it", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  const founded = await foundCompany(founding.page);
  await closeFully(founding.app);
  await blockLead(root, founded, "e2e-deploy", `[approve:deploy] ${HELD_COMMAND}`);

  const { page } = await launch();
  await page.getByTitle(INBOX_BUTTON).click();
  const inbox = page.getByRole("dialog", { name: "Inbox" });
  await expect(inbox.getByText(HELD_COMMAND)).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Approve" })).toBeVisible();
  await inbox.getByRole("button", { exact: true, name: "Done" }).click();

  await expect(page.getByText(HELD_COMMAND)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText(HELD_COMMAND)).toHaveCount(0);
});

test("an action card hands the founder its draft and carries their answer back", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  const founded = await foundCompany(founding.page);
  await closeFully(founding.app);
  const action = {
    action: "Post the launch thread on r/SideProject",
    draft: "We built a tip jar.\nTry it!",
    instructions: "Post it from your account, then send me its URL.",
  };
  await blockLead(root, founded, "e2e-post", `[action] ${JSON.stringify(action)}`);

  const { page } = await launch();
  await page.getByTitle(INBOX_BUTTON).click();
  const inbox = page.getByRole("dialog", { name: "Inbox" });
  await expect(inbox.getByText(action.action)).toBeVisible();
  await expect(inbox.getByText(action.instructions)).toBeVisible();
  // Copy draft is left unclicked: it would overwrite the clipboard of whoever runs the suite
  await expect(inbox.getByText("We built a tip jar.")).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Copy draft" })).toBeVisible();

  const url = "https://www.reddit.com/r/SideProject/comments/e2e";
  await inbox.getByRole("textbox", { name: "Reply" }).fill(url);
  await inbox.getByRole("button", { name: `Done: ${action.action}` }).click();
  await expect(inbox.getByText(action.action)).toHaveCount(0);

  const bridge = await bridgeOf(page);
  const open = await bridge.evaluate((b) => b.listTasks({}));
  expect(open.map((t) => t.description ?? "").join("\n")).toContain(`Done. They sent back: ${url}`);
});

// `npcs`, `player` and `facing` are private to the scene; the string reaches them at runtime.
const SCENE = `window.__game.scene.getScene("office")`;
const NPC_PLACED = (employeeId: string): string =>
  `window.__game?.scene.getScene("office")?.npcs?.positionOf(${JSON.stringify(employeeId)}) != null`;

const pointSchema = z.object({ x: z.number(), y: z.number() });
type Point = z.infer<typeof pointSchema>;

const playerAt = async (page: Page): Promise<Point> =>
  pointSchema.parse(await page.evaluate(`(({ x, y }) => ({ x, y }))(${SCENE}.player.sprite)`));

const placePlayer = async (page: Page, { x, y }: Point): Promise<void> => {
  await page.evaluate(`void ${SCENE}.player.sprite.setPosition(${x}, ${y})`);
};

/** Stand the founder just left of `employeeId`, facing them, close enough to talk. */
const standBeside = async (page: Page, employeeId: string): Promise<void> => {
  await page.evaluate(`(() => {
    const scene = ${SCENE};
    const at = scene.npcs.positionOf(${JSON.stringify(employeeId)});
    scene.player.sprite.setPosition(at.x - 26, at.y);
    scene.facing = "right";
  })()`);
};

// a human beat between keys: sent within one frame, a key let go reaches the office after it has the keyboard back
const HOLD_MS = 150;

test("a key held while a window opens is let go of when it closes", async ({ launch }) => {
  const founding = await launch();
  const { employees } = await foundCompany(founding.page);
  await closeFully(founding.app);
  const bo = employees.find((e) => e.name === "Bo Chen");
  if (!bo) {
    throw new Error("the founded team has no Bo");
  }

  const { page } = await launch();
  await expect.poll(() => page.evaluate(NPC_PLACED(bo.id))).toBe(true);
  const spawn = await playerAt(page);
  const dialogue = page.locator(".dlg");
  for (const attempt of [1, 2]) {
    await standBeside(page, bo.id);
    await page.keyboard.down("e");
    await expect(dialogue, `talk #${attempt}`).toBeVisible();
    await page.waitForTimeout(HOLD_MS);
    await page.keyboard.up("e");
    await page.waitForTimeout(HOLD_MS);
    await page.keyboard.press("Escape");
    await expect(dialogue).toBeHidden();
  }

  await placePlayer(page, spawn);
  await page.keyboard.down("ArrowRight");
  await page.getByTitle("Settings").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await page.waitForTimeout(HOLD_MS);
  await page.keyboard.up("ArrowRight");
  await page.waitForTimeout(HOLD_MS);
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  const stoppedAt = await playerAt(page);
  await page.waitForTimeout(400);
  expect(await playerAt(page)).toEqual(stoppedAt);
});

test("#team stays on its newest line after a window closes over it", async ({ launch }) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await closeFully(founding.app);

  const { page } = await launch();
  const bridge = await bridgeOf(page);
  await bridge.evaluate(async (b) => {
    for (let i = 1; i <= 30; i += 1) {
      await b.postTeamChat({ text: `line ${i}` });
    }
  });
  const feed = page
    .locator(".px-window")
    .filter({ hasText: "# team" })
    .locator(".px-scroll")
    .first();
  await expect(feed.getByText("line 30")).toBeInViewport();

  await page.getByTitle("Settings").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { exact: true, name: "Done" }).click();
  await expect(settings).toBeHidden();
  await expect(feed.getByText("line 30")).toBeInViewport();
});

test("#team shows the room again once its window reopens from the dock", async ({ launch }) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await closeFully(founding.app);

  const { app, page } = await launch();
  await expect(page.getByText("# team")).toBeVisible();
  const bridge = await bridgeOf(page);
  await bridge.evaluate((b) => b.postTeamChat({ text: "said before the window closed" }));
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.close();
    }
  });
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(0);
  await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"));

  const appPages = (): Page[] =>
    app.windows().filter((p) => !p.isClosed() && /^(?:file|https?):/u.test(p.url()));
  await expect.poll(() => appPages().length).toBe(1);
  const [window] = appPages();
  if (!window) {
    throw new Error("no window reopened");
  }
  await expect(window.getByText("said before the window closed")).toBeVisible();
});

const LONG_QUESTION = Array.from(
  { length: 20 },
  (_, i) => `Point ${i + 1}: which way should the tip jar go before I continue?`,
).join("\n");

test("a long question keeps its lines and the dialogue stays on screen", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  const founded = await foundCompany(founding.page);
  await closeFully(founding.app);
  await blockLead(root, founded, "e2e-long-ask", LONG_QUESTION);
  const lead = founded.employees.find((e) => e.id === founded.company.leaderId);
  if (!lead) {
    throw new Error("the founded company has no lead");
  }

  const { page } = await launch();
  await page.getByTitle(INBOX_BUTTON).click();
  const inbox = page.getByRole("dialog", { name: "Inbox" });
  await expect(inbox.getByText(/Point 1:/u)).toBeVisible();
  await expect(inbox.getByText(/Point 1:/u)).toHaveCSS("white-space", "pre-wrap");
  await inbox.getByRole("button", { exact: true, name: "Done" }).click();

  await page.getByRole("button", { name: /team/iu }).click();
  await page.getByTitle(`Talk to ${lead.name}`).click();
  const dialogue = page.locator(".dlg");
  await expect(dialogue.getByText(/Point 1:/u)).toBeVisible();
  await expect(dialogue.getByText(/Point 1:/u)).toHaveCSS("white-space", "pre-wrap");
  await expect(dialogue.locator(".dlg-menu")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTitle("Leave (esc)")).toBeInViewport({ ratio: 1 });
});

test("hovering the dialogue's menu leaves the typed answer where the founder is typing", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  const founded = await foundCompany(founding.page);
  await closeFully(founding.app);
  await blockLead(root, founded, "e2e-color", "Which color?");
  const lead = founded.employees.find((e) => e.id === founded.company.leaderId);
  if (!lead) {
    throw new Error("the founded company has no lead");
  }

  const { page } = await launch();
  await page.getByRole("button", { name: /team/iu }).click();
  await page.getByTitle(`Talk to ${lead.name}`).click();
  const answer = page.locator(".dlg").getByPlaceholder("Your answer…");
  await expect(answer).toBeFocused();
  await page.keyboard.type("Blu");
  await page.locator(".dlg-menu .px-menu-item").first().hover();
  await page.keyboard.type("e");
  await expect(answer).toBeFocused();
  await expect(answer).toHaveValue("Blue");
});

test("an answer being typed survives a status event of the asker's", async ({ launch, root }) => {
  const founding = await launch();
  const founded = await foundCompany(founding.page);
  await closeFully(founding.app);
  await blockLead(root, founded, "e2e-color", "Which color?");
  const lead = founded.employees.find((e) => e.id === founded.company.leaderId);
  if (!lead) {
    throw new Error("the founded company has no lead");
  }

  const { page } = await launch();
  await page.getByRole("button", { name: /team/iu }).click();
  await page.getByTitle(`Talk to ${lead.name}`).click();
  const dialogue = page.locator(".dlg");
  const answer = dialogue.getByPlaceholder("Your answer…");
  await expect(answer).toBeFocused();
  await page.keyboard.type("Blu");

  const bridge = await bridgeOf(page);
  await bridge.evaluate(
    (b, employeeId) => b.directEmployee({ employeeId, instruction: "Tidy the README." }),
    lead.id,
  );
  await expect(
    dialogue.locator(".dlg-menu").getByRole("button", { name: /Check in:/u }),
  ).toBeVisible();
  await page.keyboard.type("e");
  await expect(answer).toBeFocused();
  await expect(answer).toHaveValue("Blue");
});

test("Talk… keeps the keys while an ask waits and a status event of the asker's lands", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  const founded = await foundCompany(founding.page);
  await closeFully(founding.app);
  await blockLead(root, founded, "e2e-color", "Which color?");
  const lead = founded.employees.find((e) => e.id === founded.company.leaderId);
  if (!lead) {
    throw new Error("the founded company has no lead");
  }

  const { page } = await launch();
  await page.getByRole("button", { name: /team/iu }).click();
  await page.getByTitle(`Talk to ${lead.name}`).click();
  const dialogue = page.locator(".dlg");
  await dialogue
    .locator(".dlg-menu")
    .getByRole("button", { name: /Talk…/u })
    .click();
  const talk = dialogue.getByPlaceholder(`Tell ${lead.name} what to do…`);
  await expect(talk).toBeFocused();
  await page.keyboard.type("Ship the ");

  const bridge = await bridgeOf(page);
  await bridge.evaluate(
    (b, employeeId) => b.directEmployee({ employeeId, instruction: "Tidy the README." }),
    lead.id,
  );
  await page.waitForTimeout(500);
  await page.keyboard.type("pricing page");
  await expect(talk).toBeFocused();
  await expect(talk).toHaveValue("Ship the pricing page");
  await expect(dialogue.getByPlaceholder("Your answer…")).toHaveValue("");
});

test("#team keeps the keys after a message is sent", async ({ launch }) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await closeFully(founding.app);

  const { page } = await launch();
  const field = page.locator(".px-window").filter({ hasText: "# team" }).getByRole("textbox");
  await field.click();
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await expect(page.getByText("first", { exact: true })).toBeVisible();
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  expect(await page.evaluate(`${SCENE}.input.keyboard.enabled`)).toBe(false);
  await page.keyboard.type("second");
  await expect(field).toHaveValue("second");
});

test("the dialogue's cursor stays on Talk… when a row is added ahead of it meanwhile", async ({
  launch,
}) => {
  const founding = await launch();
  const founded = await foundCompany(founding.page);
  await closeFully(founding.app);
  const engineer = founded.employees.find((e) => e.id !== founded.company.leaderId);
  if (!engineer) {
    throw new Error("the founded company has only its lead");
  }

  const { page } = await launch();
  await page.getByRole("button", { name: /team/iu }).click();
  await page.getByTitle(`Talk to ${engineer.name}`).click();
  const dialogue = page.locator(".dlg");
  const menu = dialogue.locator(".dlg-menu");
  await menu.getByRole("button", { name: /Talk…/u }).click();
  await expect(dialogue.getByPlaceholder(`Tell ${engineer.name} what to do…`)).toBeFocused();

  // queued work puts a Check in row ahead of Talk… while the menu is away
  const bridge = await bridgeOf(page);
  await bridge.evaluate(
    (b, employeeId) => b.directEmployee({ employeeId, instruction: "Tidy the README." }),
    engineer.id,
  );
  await expect(dialogue.getByText(/queued/u)).toBeVisible();
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");

  await expect(menu.getByRole("button", { name: /Check in:/u })).toBeVisible();
  await expect(menu.locator('.px-menu-item[data-cur="true"]')).toHaveText(/Talk…/u);
  await expect(menu.getByRole("button", { name: /Talk…/u })).toBeFocused();
});
