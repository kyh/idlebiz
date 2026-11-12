import { apiOf, expect, foundCompany, keyShot, readVault, test, writeVault } from "./harness";

test("a Vercel token Vercel takes binds the product's project and is kept in the vault", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.close();

  const { page } = await launch();
  const users = page.getByRole("button", { name: /users/iu });
  await users.click();
  await page.getByRole("button", { name: "▲ Vercel" }).click();
  const connect = page.getByRole("dialog", { name: "Connect Vercel" });
  const token = "vercel_e2e_taken_token";
  await connect.getByPlaceholder("vercel_…").fill(token);
  await connect.getByRole("button", { name: "Continue" }).click();
  await expect(connect.getByText("Signed in as e2e")).toBeVisible();
  await connect.getByRole("button", { name: /e2e-tip-jar/u }).click();
  await expect(connect).toBeHidden();

  await users.click();
  await expect(page.getByRole("button", { exact: true, name: "▲ Vercel ✓" })).toBeVisible();
  expect(await readVault(root)).toHaveProperty("VERCEL_TOKEN", token);
});

test("a Vercel token is kept with no project picked, for the first deploy to make one", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.close();

  const { page } = await launch();
  await page.getByRole("button", { name: /users/iu }).click();
  await page.getByRole("button", { name: "▲ Vercel" }).click();
  const connect = page.getByRole("dialog", { name: "Connect Vercel" });
  await connect.getByPlaceholder("vercel_…").fill("vercel_e2e_fresh_token");
  await connect.getByRole("button", { name: "Continue" }).click();
  await expect(connect.getByText("Signed in as e2e")).toBeVisible();
  await connect.getByRole("button", { name: "Save token only" }).click();
  await expect(connect).toBeHidden();

  expect(await readVault(root)).toHaveProperty("VERCEL_TOKEN", "vercel_e2e_fresh_token");
  const api = await apiOf(page);
  const [product] = await api.products.list();
  expect(product?.vercel).toBeNull();
});

test("a Vercel token Vercel refuses is shown as refused and never saved", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.close();

  const { page } = await launch({ keys: "refused" });
  await page.getByRole("button", { name: /users/iu }).click();
  await page.getByRole("button", { name: "▲ Vercel" }).click();
  const connect = page.getByRole("dialog", { name: "Connect Vercel" });
  await connect.getByPlaceholder("vercel_…").fill("vercel_e2e_not_a_token");
  await connect.getByRole("button", { name: "Continue" }).click();
  await expect(
    connect.getByText("That token was rejected — create one at vercel.com/account/tokens."),
  ).toBeVisible();
  expect(await readVault(root)).not.toHaveProperty("VERCEL_TOKEN");
});

test("a Stripe key Stripe refuses is shown as refused and never saved", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.close();

  const { page } = await launch({ keys: "refused" });
  await page.getByRole("button", { name: /revenue/iu }).click();
  const budget = page.getByRole("dialog", { name: "Budget" });
  const key = budget.getByLabel("Stripe secret key");
  const save = budget.getByRole("button", { exact: true, name: "Save" });

  await key.fill("pk_test_e2e");
  await save.click();
  await expect(budget.getByRole("alert")).toContainText("That isn't a secret key");

  await key.fill("sk_test_e2eNotARealKey");
  await save.click();
  await expect(budget.getByRole("alert")).toContainText("Stripe doesn't recognise this key");
  expect(await readVault(root)).not.toHaveProperty("STRIPE_SECRET_KEY");
});

test("a Stripe key Stripe takes is kept in the vault, shown as set, replaceable and removable", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.close();

  const { page } = await launch();
  await page.getByRole("button", { name: /revenue/iu }).click();
  const budget = page.getByRole("dialog", { name: "Budget" });
  const key = "sk_test_e2eGood1234";
  await budget.getByLabel("Stripe secret key").fill(key);
  await budget.getByRole("button", { exact: true, name: "Save" }).click();
  const saved = budget.getByText("✓ key …1234");
  await expect(saved).toBeVisible();
  await expect(saved.getByText("test", { exact: true })).toBeVisible();
  await keyShot(page, "stripe-key-set");
  expect(await readVault(root)).toHaveProperty("STRIPE_SECRET_KEY", key);

  await budget.getByLabel("New Stripe secret key").fill("sk_test_e2eGood5678");
  await budget.getByRole("button", { name: "Replace key" }).click();
  await expect(budget.getByText("✓ key …5678")).toBeVisible();

  await budget.getByRole("button", { exact: true, name: "Remove" }).click();
  await expect(budget.getByLabel("Stripe secret key", { exact: true })).toBeVisible();
  expect(await readVault(root)).not.toHaveProperty("STRIPE_SECRET_KEY");
});

test("a token pasted into vault.json is used", async ({ launch, root }) => {
  const founding = await launch();
  const { product } = await foundCompany(founding.page);
  const api = await apiOf(founding.page);
  await api.vercel.connect({ productId: product.id, projectId: "prj_e2e", projectName: "e2e" });
  await founding.close();
  const token = "e2e-pasted-vercel-token";
  await writeVault(root, { ...(await readVault(root)), VERCEL_TOKEN: token });

  const { page } = await launch({ keys: "refused" });
  // only a token main read reaches Vercel, which here refuses every one
  await expect(page.getByRole("button", { name: /vercel refused/iu })).toBeVisible();
});

test("a Printful token Printful takes is kept in the vault, shown with its store, replaceable and removable", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.close();

  const { page } = await launch();
  await page.getByRole("button", { name: /revenue/iu }).click();
  const budget = page.getByRole("dialog", { name: "Budget" });
  const token = "pf_e2e_private_token_9876";
  await budget.getByLabel("Printful private token").fill(token);
  await budget.getByRole("button", { name: "Save token" }).click();
  await expect(budget.getByText("✓ token …9876 · E2E Prints")).toBeVisible();
  expect(await readVault(root)).toHaveProperty("PRINTFUL_TOKEN", token);

  const renewed = "pf_e2e_private_token_5432";
  await budget.getByLabel("New Printful private token").fill(renewed);
  await budget.getByRole("button", { name: "Replace token" }).click();
  await expect(budget.getByText("✓ token …5432 · E2E Prints")).toBeVisible();

  await budget.getByRole("button", { name: "Remove token" }).click();
  await expect(budget.getByLabel("Printful private token", { exact: true })).toBeVisible();
  expect(await readVault(root)).not.toHaveProperty("PRINTFUL_TOKEN");
});
