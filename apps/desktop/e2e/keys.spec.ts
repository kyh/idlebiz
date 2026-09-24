import {
  bridgeOf,
  expect,
  foundCompany,
  readSecrets,
  secretsText,
  stubStripeAndVercel,
  test,
  writeSecrets,
} from "./harness";

const SEALED = /^sealed:v1:/u;

test("a Vercel token Vercel takes binds the product's project and is kept sealed", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.app.close();

  const { app, page } = await launch();
  await stubStripeAndVercel(app);
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
  expect(await secretsText(root)).not.toContain(token);
  const secrets = await readSecrets(root);
  expect(secrets.VERCEL_TOKEN).toMatch(SEALED);
});

test("a Vercel token Vercel refuses is shown as refused and never saved", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.app.close();

  const { page } = await launch();
  await page.getByRole("button", { name: /users/iu }).click();
  await page.getByRole("button", { name: "▲ Vercel" }).click();
  const connect = page.getByRole("dialog", { name: "Connect Vercel" });
  await connect.getByPlaceholder("vercel_…").fill("vercel_e2e_not_a_token");
  await connect.getByRole("button", { name: "Continue" }).click();
  await expect(
    connect.getByText("That token was rejected — create one at vercel.com/account/tokens."),
  ).toBeVisible();
  expect(await readSecrets(root)).not.toHaveProperty("VERCEL_TOKEN");
});

test("a Stripe key Stripe refuses is shown as refused and never saved", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.app.close();

  const { page } = await launch();
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
  expect(await readSecrets(root)).not.toHaveProperty("STRIPE_SECRET_KEY");
});

test("a Stripe key Stripe takes is kept sealed, shown as set and removable", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  await foundCompany(founding.page);
  await founding.app.close();

  const { app, page } = await launch();
  await stubStripeAndVercel(app);
  await page.getByRole("button", { name: /revenue/iu }).click();
  const budget = page.getByRole("dialog", { name: "Budget" });
  const key = "sk_test_e2eGood1234";
  await budget.getByLabel("Stripe secret key").fill(key);
  await budget.getByRole("button", { exact: true, name: "Save" }).click();
  const saved = budget.getByText("✓ key …1234");
  await expect(saved).toBeVisible();
  await expect(saved.getByText("test", { exact: true })).toBeVisible();
  expect(await secretsText(root)).not.toContain(key);
  const secrets = await readSecrets(root);
  expect(secrets.STRIPE_SECRET_KEY).toMatch(SEALED);

  await budget.getByRole("button", { name: "Remove" }).click();
  await expect(budget.getByLabel("Stripe secret key")).toBeVisible();
  expect(await readSecrets(root)).not.toHaveProperty("STRIPE_SECRET_KEY");
});

test("a token pasted into secrets.json is sealed at boot and still used", async ({
  launch,
  root,
}) => {
  const founding = await launch();
  const { product } = await foundCompany(founding.page);
  const bridge = await bridgeOf(founding.page);
  await bridge.evaluate(
    (b, productId) => b.vercelConnect({ productId, projectId: "prj_e2e", projectName: "e2e" }),
    product.id,
  );
  await founding.app.close();
  const token = "e2e-pasted-vercel-token";
  await writeSecrets(root, { ...(await readSecrets(root)), VERCEL_TOKEN: token });

  const { page } = await launch();
  expect(await secretsText(root)).not.toContain(token);
  const secrets = await readSecrets(root);
  expect(secrets.VERCEL_TOKEN).toMatch(SEALED);
  // only a token main opened reaches Vercel, which refuses this one
  await expect(page.getByRole("button", { name: /vercel refused/iu })).toBeVisible();
});
