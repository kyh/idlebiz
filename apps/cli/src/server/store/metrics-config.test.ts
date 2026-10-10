import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-metrics-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const { readMetricsConfig, writeMetricsConfig } = await import("./metrics-config");

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

const stripeAccount = { accountId: "acct_1", connectedAt: 0, livemode: false };

it("refuses to merge into a metrics.json it cannot read", () => {
  const file = path.join(root, "company", "metrics.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const handTyped = '{"stripeAccount":"acct_1"}';
  writeFileSync(file, handTyped);

  expect(() => writeMetricsConfig({ stripeAccount })).toThrow("it will not be overwritten");
  expect(readFileSync(file, "utf-8")).toBe(handTyped);
});

it("reads a file with providers this build no longer has", () => {
  const file = path.join(root, "company", "metrics.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ plausible: { domain: "x.com" }, stripe: true, stripeAccount }),
  );

  expect(readMetricsConfig()).toEqual({ stripeAccount });
});
