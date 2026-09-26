import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bridgeOf, closeFully, expect, foundCompany, test } from "./harness";
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
