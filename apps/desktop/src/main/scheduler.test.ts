import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-scheduler-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("./store/store");
const { scheduler } = await import("./scheduler");

afterAll(() => {
  scheduler.stop();
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env["IDLEBIZ_ROOT_DIR"];
  } else {
    process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
  }
});

it("ignores queue drains after stop and resumes admission only after start", () => {
  store.initStore();
  const company = store.foundCompany({
    budget: { capUsd: 0, mode: "capped" },
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [
      {
        name: "Priya",
        persona: "ships",
        role: "engineer",
        runner: "claude",
        spriteSeed: "priya",
        title: "Engineer",
      },
    ],
    mission: "ship",
    name: "Acme",
  });
  const task = store.createTask({ companyId: company.id, title: "Waiting" });
  store.claimTask(task.id, "priya");

  scheduler.stop();
  scheduler.tick();

  expect(store.getCompany(company.id)?.autopilot).toBe(true);
  expect(store.getTask(task.id)?.state.kind).toBe("queued");

  scheduler.start();

  expect(store.getCompany(company.id)?.autopilot).toBe(false);
  expect(store.getTask(task.id)?.state.kind).toBe("queued");
  expect(store.getEmployee("priya")?.status).toBe("idle");
});
