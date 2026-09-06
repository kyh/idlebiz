import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

const root = mkdtempSync(join(tmpdir(), "idlebiz-scheduler-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("./store/store");
const { scheduler } = await import("./scheduler");

afterAll(() => {
  scheduler.stop();
  rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env["IDLEBIZ_ROOT_DIR"];
  else process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
});

it("ignores queue drains after stop and resumes admission only after start", () => {
  store.initStore();
  const company = store.foundCompany({
    name: "Acme",
    mission: "ship",
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    budget: { mode: "capped", capUsd: 0 },
    hires: [
      {
        name: "Priya",
        role: "engineer",
        title: "Engineer",
        persona: "ships",
        runner: "claude",
        spriteSeed: "priya",
      },
    ],
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
