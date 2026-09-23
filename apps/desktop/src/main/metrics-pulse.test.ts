import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-pulse-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("./store/store");
const { PULSE_MS } = await import("./metrics");
const { metricsPulse } = await import("./metrics-pulse");

const BOOT = 1_000_000;
const HOUR = 3_600_000;

beforeEach(() => {
  store.initStore();
  vi.useFakeTimers({ now: BOOT });
});

afterEach(() => {
  metricsPulse.stop();
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env["IDLEBIZ_ROOT_DIR"];
  } else {
    process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
  }
});

describe("metricsPulse.pulsingSince", () => {
  it("is null until the pulse starts and once it stops", () => {
    expect(metricsPulse.pulsingSince(Date.now())).toBeNull();
    metricsPulse.start();
    expect(metricsPulse.pulsingSince(Date.now())).toBe(BOOT);
    metricsPulse.stop();
    expect(metricsPulse.pulsingSince(Date.now())).toBeNull();
  });

  it("holds while the pulse keeps beating", () => {
    metricsPulse.start();
    vi.advanceTimersByTime(10 * PULSE_MS);
    expect(metricsPulse.pulsingSince(Date.now())).toBe(BOOT);
  });

  it("is null on waking before the pulse beats again, then counts from that beat", () => {
    metricsPulse.start();
    vi.setSystemTime(BOOT + HOUR);
    expect(metricsPulse.pulsingSince(Date.now())).toBeNull();
    vi.advanceTimersByTime(PULSE_MS);
    expect(metricsPulse.pulsingSince(Date.now())).toBe(BOOT + HOUR + PULSE_MS);
  });
});
