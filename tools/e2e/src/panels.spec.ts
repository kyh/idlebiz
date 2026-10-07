import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { apiOf, expect, foundCompany, test } from "./harness";

test("an out-of-budget company tells the founder to press Start once the cap is raised", async ({
  launch,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.close();

  const { page } = await launch();
  await page.getByRole("button", { name: /revenue/iu }).click();
  const budget = page.getByRole("dialog", { name: "Budget" });
  await expect(budget.getByText(/Out of budget/u)).toContainText("then press ▶ Start");
});

test("retiring the selected product shows the whole company again", async ({ launch }) => {
  const founding = await launch();
  await foundCompany(founding.page);
  const api = await apiOf(founding.page);
  await api.evaluate((a) =>
    a.products.create({ description: "A second thing to sell.", name: "Side Quest" }),
  );
  await founding.close();

  const { page } = await launch();
  await page.getByRole("button", { name: /2 products/u }).click();
  const products = page.getByRole("dialog", { name: "Products" });
  await products.getByRole("button", { name: /Side Quest/u }).click();
  await expect(products.getByText("Bets · Side Quest")).toBeVisible();

  const card = products.locator(".px-inset").filter({ hasText: "▶ Side Quest" });
  await card.getByRole("button", { exact: true, name: "retire" }).click();
  await card.getByRole("button", { exact: true, name: "retire it" }).click();
  await expect(products.getByText("Side Quest")).toHaveCount(0);
  await expect(products.getByText("Bets", { exact: true })).toBeVisible();
  await expect(products.getByText("Shipping log", { exact: true })).toBeVisible();
});

test("Start while out of budget says why and leaves the office paused", async ({ launch }) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.close();

  const { page } = await launch();
  await page.getByRole("button", { name: /Start/u }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Out of budget — raise the cap in Budget first.",
  );
  await expect(page.getByRole("button", { name: /Start/u })).toBeVisible();
});

test("a file boot skipped is named in full, so the founder can find it", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  const { company } = await foundCompany(founding.page);
  await founding.close();
  const taskDir = path.join(root, company.id, "tasks", "a-fairly-long-task-slug-the-lead-wrote");
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, "TASK.md"), "---\nbroken: [\n---\n");

  const { page } = await launch();
  await page.getByTitle("Settings").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const skipped = settings.getByText(path.join(taskDir, "TASK.md"), { exact: true });
  await expect(skipped).toBeVisible();
  expect(await skipped.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test("a Stripe sign-in left in the browser can be started over from the Budget panel", async ({
  launch,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.close();

  const { opened, page } = await launch();
  await page.getByRole("button", { name: /revenue/iu }).click();
  const budget = page.getByRole("dialog", { name: "Budget" });
  await budget.getByRole("button", { name: "Connect Stripe" }).click();
  await expect(budget.getByText("Waiting for Stripe in your browser…")).toBeVisible();

  await budget.getByRole("button", { name: "Start over" }).click();
  await expect.poll(() => opened.filter(({ kind }) => kind === "url").length).toBe(2);
  await expect(budget.getByText("Waiting for Stripe in your browser…")).toBeVisible();
});
