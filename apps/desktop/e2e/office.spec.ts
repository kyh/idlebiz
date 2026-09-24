import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, foundCompany, test } from "./harness";

// `npcs` is private to the scene and the manager; the string reaches them at runtime.
const NPCS_IN_OFFICE = `window.__game?.scene.getScene("office")?.npcs?.npcs.size ?? -1`;

const HELD_COMMAND = "deploy tip-jar to production";

test("a founded company boots into the office", async ({ launch }) => {
  const founding = await launch();
  const { employees } = await foundCompany(founding.page);
  await founding.app.close();

  const { page } = await launch();
  for (const plate of [/revenue/iu, /users/iu, /product/iu, /team/iu]) {
    await expect(page.getByRole("button", { name: plate })).toBeVisible();
  }
  await expect(page.getByText("# team")).toBeVisible();
  await expect.poll(() => page.evaluate(NPCS_IN_OFFICE)).toBe(employees.length);
});

test("a held command waits in #team and the inbox until the founder denies it", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  const { company, product } = await foundCompany(founding.page);
  await founding.app.close();
  const taskDir = path.join(root, company.id, "tasks", "e2e-deploy");
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    path.join(taskDir, "TASK.md"),
    [
      "---",
      'kind: "task"',
      'name: "Deploy the tip jar"',
      'schema: "agentcompanies/v1"',
      'slug: "e2e-deploy"',
      "metadata:",
      `  createdAt: ${Date.now()}`,
      '  origin: "founder"',
      '  priority: "high"',
      '  status: "blocked"',
      `  assigneeId: ${JSON.stringify(company.leaderId)}`,
      `  productId: ${JSON.stringify(product.id)}`,
      `  blockedQuestion: ${JSON.stringify(`[approve:deploy] ${HELD_COMMAND}`)}`,
      "---",
      "Ship the tip jar.",
      "",
    ].join("\n"),
  );

  const { page } = await launch();
  await page.getByTitle("Questions, connect requests and stuck tasks waiting on you").click();
  const inbox = page.getByRole("dialog", { name: "Inbox" });
  await expect(inbox.getByText(HELD_COMMAND)).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(inbox.getByRole("button", { name: "Approve" })).toBeVisible();
  await inbox.getByRole("button", { name: "Done" }).click();

  await expect(page.getByText(HELD_COMMAND)).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText(HELD_COMMAND)).toHaveCount(0);
});
