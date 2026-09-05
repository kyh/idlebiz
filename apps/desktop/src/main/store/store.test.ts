import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The store roots itself at ~/.idlebiz and homedir() reads HOME, so the whole
// suite lives in a throwaway home; the store loads after HOME points there.
const home = mkdtempSync(join(tmpdir(), "idlebiz-store-"));
process.env.HOME = home;
const store = await import("./store");
const { shippedDir, tasksDir } = await import("@/main/paths");

const hire = (name: string) =>
  ({
    deskIndex: 0,
    name,
    role: "engineer",
    title: "Engineer",
    persona: "ships",
    runner: "claude",
    spriteSeed: name,
  }) as const;

const found = () =>
  store.foundCompany({
    name: "Acme",
    mission: "ship",
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    budget: { mode: "infinite" },
    hires: [],
  });

/** Queue, lock and settle a task the way a run does. */
function finish(taskId: string, employeeId: string, summary: string): void {
  store.claimTask(taskId, employeeId);
  store.lockTaskForRun(taskId, "run-1");
  store.settleTask(taskId, "run-1", { kind: "done", summary });
}

describe("the shipping log", () => {
  beforeAll(() => store.initStore());
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("moves a task that settles done out of the open queue into shipped/", () => {
    const co = found();
    const emp = store.createEmployee({ companyId: co.id, ...hire("Priya") });
    const task = store.createTask({ companyId: co.id, title: "Ship it" });
    finish(task.id, emp.id, "shipped");

    expect(existsSync(join(tasksDir(co.id), task.id))).toBe(false);
    expect(existsSync(join(shippedDir(co.id), task.id, "TASK.md"))).toBe(true);
    expect(store.listOpenTasks(co.id)).toEqual([]);
    expect(store.getTask(task.id)).toBeNull();
    expect(store.listShippedTasks(co.id).map((t) => t.id)).toEqual([task.id]);
  });

  it("reads the shipping log from disk only when asked, and boot shelves done work left in the queue", () => {
    const co = found();
    const emp = store.createEmployee({ companyId: co.id, ...hire("Sana") });
    const shipped = store.createTask({ companyId: co.id, title: "Done before" });
    finish(shipped.id, emp.id, "one");
    const open = store.createTask({ companyId: co.id, title: "Still open" });

    // a save from before shipped/ existed: a done package still under tasks/
    const legacy = store.createTask({ companyId: co.id, title: "Legacy done" });
    store.claimTask(legacy.id, emp.id);
    store.lockTaskForRun(legacy.id, "run-2");
    store.settleTask(legacy.id, "run-2", { kind: "done", summary: "two" });
    const legacyPkg = join(shippedDir(co.id), legacy.id);
    renameSync(legacyPkg, join(tasksDir(co.id), legacy.id));

    store.initStore();
    expect(existsSync(join(tasksDir(co.id), legacy.id))).toBe(false);
    expect(existsSync(legacyPkg)).toBe(true);
    expect(store.listOpenTasks(co.id).map((t) => t.id)).toEqual([open.id]);
    expect(
      store
        .listShippedTasks(co.id)
        .map((t) => t.id)
        .toSorted(),
    ).toEqual([legacy.id, shipped.id].toSorted());
  });

  it("never hands a new task a slug the shipping log already holds", () => {
    const co = found();
    const emp = store.createEmployee({ companyId: co.id, ...hire("Wren") });
    const first = store.createTask({ companyId: co.id, title: "Same title" });
    finish(first.id, emp.id, "done");
    const second = store.createTask({ companyId: co.id, title: "Same title" });
    expect(second.id).not.toBe(first.id);
  });
});
