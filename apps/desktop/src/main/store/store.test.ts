import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The store roots itself at ~/.idlebiz and homedir() reads HOME, so the whole
// suite lives in a throwaway home; the store loads after HOME points there.
const home = mkdtempSync(join(tmpdir(), "idlebiz-store-"));
process.env.HOME = home;
const store = await import("./store");
const { productWorkspace, productsDir, shippedDir, tasksDir } = await import("@/main/paths");

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

describe("products", () => {
  it("founds a company with its first product, born in the company workspace", () => {
    const co = found();
    const [first, ...rest] = store.listProducts(co.id);
    expect(rest).toEqual([]);
    expect(first?.name).toBe(co.name);
    expect(first?.workspaceDir).toBe(co.workspaceDir);
    expect(existsSync(join(productsDir(co.id), first?.id ?? "", "PRODUCT.md"))).toBe(true);
  });

  it("gives a later product its own workspace and tells every agent about it", () => {
    const co = found();
    // ids are per company, and the store's lookups scan every company: a fresh name
    const emp = store.createEmployee({ companyId: co.id, ...hire("Quinn") });
    const gadget = store.createProduct({
      companyId: co.id,
      name: "Gadget",
      description: "A second thing.",
    });
    expect(gadget.workspaceDir).toBe(productWorkspace(co.id, gadget.id));
    expect(existsSync(gadget.workspaceDir)).toBe(true);
    expect(store.employeeInstructions(emp.id)).toContain(gadget.workspaceDir);
    expect(store.attentionProduct(co.id)?.id).toBe(store.listProducts(co.id)[0]?.id);
  });

  it("attributes a ship to the product the task named, and turns autopilot to the other", () => {
    const co = found();
    const emp = store.createEmployee({ companyId: co.id, ...hire("Ravi") });
    const first = store.listProducts(co.id)[0];
    const gadget = store.createProduct({ companyId: co.id, name: "Gadget", description: "x" });
    const task = store.createTask({ companyId: co.id, productId: gadget.id, title: "Ship it" });
    finish(task.id, emp.id, "done");
    store.recordShip(co.id, task.productId);
    expect(store.getProduct(gadget.id)?.ships).toBe(1);
    expect(store.getProduct(first?.id ?? "")?.ships).toBe(0);
    expect(store.getCompany(co.id)?.ships).toBe(1);
    expect(store.attentionProduct(co.id)?.id).toBe(first?.id);
    expect(store.listShippedTasks(co.id)[0]?.productId).toBe(gadget.id);
  });

  it("gives a company from before products its one product, with the binding metrics.json held", () => {
    const co = found();
    // the save as an older build left it: no products/, a Vercel binding in metrics.json
    rmSync(productsDir(co.id), { recursive: true, force: true });
    mkdirSync(join(home, ".idlebiz", co.id), { recursive: true });
    writeFileSync(
      join(home, ".idlebiz", co.id, "metrics.json"),
      JSON.stringify({ vercel: { projectId: "prj_old", projectName: "old", teamId: "team_9" } }),
    );
    store.initStore();
    const [first] = store.listProducts(co.id);
    expect(first?.workspaceDir).toBe(co.workspaceDir);
    expect(first?.vercel).toEqual({ projectId: "prj_old", projectName: "old", teamId: "team_9" });
    expect(readFileSync(join(home, ".idlebiz", co.id, "metrics.json"), "utf8")).not.toContain(
      "prj_old",
    );
  });
});
