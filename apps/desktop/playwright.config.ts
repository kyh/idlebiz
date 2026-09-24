import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 15_000 },
  globalSetup: "./e2e/global-setup.ts",
  reporter: "list",
  testDir: "e2e",
  timeout: 90_000,
  tsconfig: "./tsconfig.e2e.json",
  // one app at a time: every launch takes the same single-instance lock
  workers: 1,
});
