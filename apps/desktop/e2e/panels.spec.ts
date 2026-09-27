import { bridgeOf, closeFully, expect, foundCompany, test } from "./harness";

test("an out-of-budget company tells the founder to press Start once the cap is raised", async ({
  launch,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await closeFully(founding.app);

  const { page } = await launch();
  await page.getByRole("button", { name: /revenue/iu }).click();
  const budget = page.getByRole("dialog", { name: "Budget" });
  await expect(budget.getByText(/Out of budget/u)).toContainText("then press ▶ Start");
});

test("retiring the selected product shows the whole company again", async ({ launch }) => {
  const founding = await launch();
  await foundCompany(founding.page);
  const bridge = await bridgeOf(founding.page);
  await bridge.evaluate((b) =>
    b.createProduct({ description: "A second thing to sell.", name: "Side Quest" }),
  );
  await closeFully(founding.app);

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
  await closeFully(founding.app);

  const { page } = await launch();
  await page.getByRole("button", { name: /Start/u }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Out of budget — raise the cap in Budget first.",
  );
  await expect(page.getByRole("button", { name: /Start/u })).toBeVisible();
});
