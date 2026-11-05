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

// On CI (CI's e2e-macos) a run leaves what an agent reads after it with no window: results.json,
// SUMMARY.md, the key screenshots, and a failure's trace and screenshot. A retry classes a failure
// as flaky and records a second trace, but never turns it green.
const onCi: PlaywrightTestConfig = {
  failOnFlakyTests: true,
  forbidOnly: true,
  // under the step's own 15 minutes, so the reporters still write what they hold
  globalTimeout: 12 * 60_000,
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
