import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 15_000 },
  reporter: "list",
  testDir: "e2e",
  timeout: 90_000,
  tsconfig: "./tsconfig.e2e.json",
  // one app at a time: each launch shows its window and takes focus
  workers: 1,
});
