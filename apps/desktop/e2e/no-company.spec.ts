import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./harness";

test("a first launch opens on the title screen", async ({ launch }) => {
  const { page } = await launch();
  await expect(page.getByRole("img", { name: "IdleBiz" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start your company" })).toBeVisible();
});

test("a save a newer IdleBiz wrote asks for an update, not a fix", async ({ launch, root }) => {
  await mkdir(path.join(root, "later-co"), { recursive: true });
  await writeFile(
    path.join(root, "later-co", "COMPANY.md"),
    '---\nname: "Later Co"\nslug: "later-co"\nmetadata:\n  format: 999\n  createdAt: 1\n---\n',
  );

  const { page } = await launch();
  const curtain = page.getByRole("alertdialog");
  await expect(curtain).toContainText("Update IdleBiz to open it");
  await expect(curtain).not.toContainText("Fix or move it");
});
