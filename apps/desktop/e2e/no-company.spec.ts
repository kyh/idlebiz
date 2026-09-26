import { expect, test } from "./harness";

test("a first launch opens on the title screen", async ({ launch }) => {
  const { page } = await launch();
  await expect(page.getByRole("img", { name: "IdleBiz" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start your company" })).toBeVisible();
});
