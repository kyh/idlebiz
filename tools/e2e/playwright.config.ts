import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 15_000 },
  reporter: "list",
  testDir: "src",
  timeout: 90_000,
  tsconfig: "./tsconfig.json",
  // one app at a time: each launch shows its window and takes focus
  workers: 1,
});
