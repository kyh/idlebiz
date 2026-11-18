import { defineConfig } from "@playwright/test";
import type { PlaywrightTestConfig } from "@playwright/test";

const anywhere: PlaywrightTestConfig = {
  expect: { timeout: 15_000 },
  outputDir: "test-results",
  reporter: [["list"], ["./src/summary-reporter.ts"]],
  testDir: "src",
  timeout: 90_000,
  tsconfig: "./tsconfig.json",
};

const onCi: PlaywrightTestConfig = {
  failOnFlakyTests: true,
  forbidOnly: true,
  globalTimeout: 20 * 60_000,
  reporter: [
    ["list"],
    ["github"],
    ["json", { outputFile: "test-results/results.json" }],
    ["./src/summary-reporter.ts"],
  ],
  retries: 1,
  use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
  workers: 2,
};

export default defineConfig((process.env.CI ?? "") === "" ? anywhere : { ...anywhere, ...onCi });
