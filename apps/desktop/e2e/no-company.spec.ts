import type { Page } from "@playwright/test";
import { expect, test } from "./harness";

/** The page's images: how many there are, how many are still loading, and the source of each that failed. */
const images = (page: Page) =>
  page.evaluate(() => {
    const all = [...document.images];
    return {
      broken: all
        .filter((img) => img.complete && img.naturalWidth === 0)
        .map((img) => img.getAttribute("src")),
      loading: all.filter((img) => !img.complete).length,
      total: all.length,
    };
  });

const expectEveryImageLoaded = async (page: Page): Promise<void> => {
  await expect
    .poll(async () => {
      const { loading, total } = await images(page);
      return total > 0 && loading === 0;
    })
    .toBe(true);
  const { broken } = await images(page);
  expect(broken).toEqual([]);
};

test("a first launch opens on the title screen", async ({ launch }) => {
  const { page } = await launch();
  await expect(page.getByRole("img", { name: "IdleBiz" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start your company" })).toBeVisible();
});

test("the office builder and the object catalog render every image", async ({ launch }) => {
  const { page } = await launch();
  await page.evaluate(() => {
    location.hash = "#/ui";
  });
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  await expectEveryImageLoaded(page);

  await page.evaluate(() => {
    location.hash = "#/office-assets";
  });
  await expect(page.getByRole("heading", { name: "Office Objects" })).toBeVisible();
  await expectEveryImageLoaded(page);
});
