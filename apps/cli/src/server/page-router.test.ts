import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { founderActions } from "./founder-actions";
import { createPageRouter } from "./page-router";

/** The page's calls as main answers them, with no scheduler behind the founder's actions. */
const page = () =>
  createRouterClient(
    createPageRouter({
      founder: founderActions({
        enqueue: () => null,
        file: () => {
          throw new Error("these tests file nothing");
        },
      }),
      resetGame: () => Promise.resolve(),
    }),
  );

describe("the page's router", () => {
  it("keeps a fault the page raised in main's log, named as the page's, its stack after it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await page().app.fault({ message: "the panel broke", where: "crash-screen" });
    await page().app.fault({
      message: "it threw",
      stack: "boot@page.js:1:2",
      where: "office-boot",
    });
    expect(logged.mock.calls).toEqual([
      ["[page:crash-screen]", "the panel broke"],
      ["[page:office-boot]", "it threw\nboot@page.js:1:2"],
    ]);
  });

  it("refuses a fault longer than the page clips one to, saying how long it may be", async () => {
    await expect(page().app.fault({ message: "x".repeat(501), where: "window" })).rejects.toThrow(
      "Keep it to 500 characters or fewer.",
    );
  });
});
