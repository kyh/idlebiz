import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Budget } from "@/shared/domain";
import { parseDoc, reqStr, serializeDoc } from "./frontmatter";

const root = mkdtempSync(join(tmpdir(), "idlebiz-store-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("./store");
const { scheduler } = await import("@/main/scheduler");
const { productWorkspace, productsDir, shippedDir, tasksDir } = await import("@/main/paths");

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  store.initStore();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env["IDLEBIZ_ROOT_DIR"];
  else process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
});

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

const found = (budget: Budget = { mode: "infinite" }) =>
  store.foundCompany({
    name: "Acme",
    mission: "ship",
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    budget,
    hires: [],
  });

function finish(taskId: string, employeeId: string, summary: string): void {
  store.claimTask(taskId, employeeId);
  store.lockTaskForRun(taskId, "run-1");
  store.settleTask(taskId, "run-1", { kind: "done", summary });
}

function copyCompany(from: string, to: string, createdAt: number): void {
  cpSync(join(root, from), join(root, to), { recursive: true });
  const file = join(root, to, "COMPANY.md");
  const doc = parseDoc(readFileSync(file, "utf8"));
  writeFileSync(
    file,
    serializeDoc({
      ...doc,
      fields: { ...doc.fields, slug: to },
      metadata: { ...doc.metadata, createdAt },
    }),
  );
  for (const slug of readdirSync(join(root, to, "products"))) {
    const productFile = join(root, to, "products", slug, "PRODUCT.md");
    const product = parseDoc(readFileSync(productFile, "utf8"));
    const workspaceDir = reqStr(product.metadata, "workspaceDir").replace(
      join(root, from),
      join(root, to),
    );
    writeFileSync(
      productFile,
      serializeDoc({ ...product, metadata: { ...product.metadata, workspaceDir } }),
    );
  }
}

function saveSnapshot(companyId: string): Map<string, string> {
  const dir = join(root, companyId);
  return new Map(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [relative(dir, file), readFileSync(file, "utf8")];
      }),
  );
}

describe("the shipping log", () => {
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
    mkdirSync(join(root, co.id), { recursive: true });
    writeFileSync(
      join(root, co.id, "metrics.json"),
      JSON.stringify({ vercel: { projectId: "prj_old", projectName: "old", teamId: "team_9" } }),
    );
    store.initStore();
    const [first] = store.listProducts(co.id);
    expect(first?.workspaceDir).toBe(co.workspaceDir);
    expect(first?.vercel).toEqual({ projectId: "prj_old", projectName: "old", teamId: "team_9" });
    expect(readFileSync(join(root, co.id, "metrics.json"), "utf8")).not.toContain("prj_old");
  });
});

describe("scheduler queue admission", () => {
  it("leaves capped work queued without spinning on its first task", () => {
    const company = found({ mode: "capped", capUsd: 0 });
    const employee = store.createEmployee({ companyId: company.id, ...hire("Priya") });
    const teammate = store.createEmployee({ companyId: company.id, ...hire("Sana") });
    const task = store.createTask({ companyId: company.id, title: "First task" });
    const next = store.createTask({ companyId: company.id, title: "Next task" });
    store.claimTask(task.id, employee.id);
    store.claimTask(next.id, teammate.id);

    scheduler.tick();

    expect(store.getCompany(company.id)?.autopilot).toBe(false);
    expect(store.listQueuedTasks().map((queued) => queued.id)).toEqual([task.id, next.id]);
    expect(store.getEmployee(employee.id)?.status).toBe("idle");
    expect(store.getEmployee(teammate.id)?.status).toBe("idle");
  });

  it("skips a missing assignee and still checks later work", () => {
    const company = found({ mode: "capped", capUsd: 0 });
    const employee = store.createEmployee({ companyId: company.id, ...hire("Priya") });
    const orphan = store.createTask({ companyId: company.id, title: "Orphan", priority: "high" });
    const task = store.createTask({ companyId: company.id, title: "Waiting" });
    store.claimTask(orphan.id, "missing-employee");
    store.claimTask(task.id, employee.id);

    scheduler.tick();

    expect(store.listQueuedTasks().map((queued) => queued.id)).toEqual([orphan.id, task.id]);
    expect(store.getCompany(company.id)?.autopilot).toBe(false);
    expect(store.getEmployee(employee.id)?.status).toBe("idle");
  });
});

describe("active company ownership", () => {
  it("confines duplicate employee, task, and product slugs to the newest company", () => {
    const older = found({ mode: "capped", capUsd: 0 });
    const employee = store.createEmployee({ companyId: older.id, ...hire("Priya") });
    const product = store.listProducts(older.id)[0];
    if (!product) throw new Error("founding must create a product");
    const queued = store.createTask({ companyId: older.id, title: "Ship it" });
    store.claimTask(queued.id, employee.id);
    const running = store.createTask({ companyId: older.id, title: "In flight" });
    store.claimTask(running.id, employee.id);
    store.lockTaskForRun(running.id, "old-run");
    store.postTeamMessage(older.id, employee.id, "existing room history");
    copyCompany(older.id, "newer", older.createdAt + 1);
    const oldOnly = store.createEmployee({ companyId: older.id, ...hire("Old only") });
    const oldTask = store.createTask({ companyId: older.id, title: "Old only" });
    store.claimTask(oldTask.id, oldOnly.id);
    const before = saveSnapshot(older.id);

    expect(store.initStore()).toEqual({ companies: 1, skipped: [] });
    expect(store.getDefaultCompany()?.id).toBe("newer");
    expect(store.getCompany(older.id)).toBeNull();
    expect(store.getEmployee(employee.id)?.companyId).toBe("newer");
    expect(store.getTask(queued.id)?.companyId).toBe("newer");
    expect(store.getProduct(product.id)?.companyId).toBe("newer");
    expect(store.getEmployee(oldOnly.id)).toBeNull();
    expect(store.getTask(oldTask.id)).toBeNull();
    expect(store.listQueuedTasks().map((task) => task.companyId)).toEqual(["newer"]);
    expect(store.getTask(running.id)?.state.kind).toBe("queued");

    store.setEmployeeSession(employee.id, "new-session");
    store.setProductVercel(product.id, {
      projectId: "new-project",
      projectName: "New",
      teamId: null,
    });
    store.lockTaskForRun(queued.id, "new-run");
    store.settleTask(queued.id, "new-run", { kind: "done", summary: "new company shipped" });
    store.recordShip("newer", product.id);
    scheduler.tick();

    expect(store.getEmployee(employee.id)?.sessionId).toBe("new-session");
    expect(store.getProduct(product.id)?.ships).toBe(1);
    expect(store.listShippedTasks("newer").map((task) => task.id)).toEqual([queued.id]);
    expect(saveSnapshot(older.id)).toEqual(before);
  });

  it("keeps inactive company reads and explicit-company writes outside the cache", () => {
    const older = found();
    store.grantApproval(older.id, "old command");
    copyCompany(older.id, "newer", older.createdAt + 1);
    const before = saveSnapshot(older.id);
    store.initStore();

    expect(store.listEmployees(older.id)).toEqual([]);
    expect(store.listProducts(older.id)).toEqual([]);
    expect(store.listRoutines(older.id)).toEqual([]);
    expect(store.listOpenTasks(older.id)).toEqual([]);
    expect(store.listShippedTasks(older.id)).toEqual([]);
    expect(store.recentTeamMessages(older.id)).toEqual([]);
    expect(store.recentActivity(older.id, "ship")).toEqual([]);
    expect(() => store.setAutopilot(older.id, false)).toThrow("not active");
    expect(() => store.createEmployee({ companyId: older.id, ...hire("Someone") })).toThrow(
      "not active",
    );
    expect(() =>
      store.createProduct({ companyId: older.id, name: "No", description: "No" }),
    ).toThrow("not active");
    expect(() => store.createTask({ companyId: older.id, title: "No" })).toThrow("not active");
    expect(() => store.postTeamMessage(older.id, null, "No")).toThrow("not active");
    expect(() => store.grantApproval(older.id, "new command")).toThrow("not active");
    expect(() => store.consumeApproval(older.id, "old command")).toThrow("not active");
    expect(store.recordSpend(older.id, 10)).toBeNull();
    expect(store.setRealMetrics(older.id, { users: 10, revenue: 10 })).toBeNull();
    store.recordShip(older.id, "acme");
    store.markRoutineRun(older.id, "business-review");
    expect(saveSnapshot(older.id)).toEqual(before);
  });

  it("does not migrate an inactive legacy save", () => {
    const older = found();
    copyCompany(older.id, "newer", older.createdAt + 1);
    rmSync(join(root, older.id, "products"), { recursive: true });
    rmSync(join(root, older.id, "routines"), { recursive: true });
    writeFileSync(
      join(root, older.id, "metrics.json"),
      JSON.stringify({ vercel: { projectId: "old" } }),
    );
    const before = saveSnapshot(older.id);

    store.initStore();

    expect(store.getDefaultCompany()?.id).toBe("newer");
    expect(saveSnapshot(older.id)).toEqual(before);
  });

  it("breaks equal creation timestamps by slug", () => {
    const first = found();
    copyCompany(first.id, "z-last", first.createdAt + 1);
    copyCompany(first.id, "a-first", first.createdAt + 1);

    store.initStore();
    expect(store.getDefaultCompany()?.id).toBe("a-first");
    store.initStore();
    expect(store.getDefaultCompany()?.id).toBe("a-first");
  });

  it("rejects a second founding without touching the active save", () => {
    const company = found();
    const before = saveSnapshot(company.id);

    expect(() => found()).toThrow("already active");

    expect(store.getDefaultCompany()?.id).toBe(company.id);
    expect(existsSync(join(root, "acme-2"))).toBe(false);
    expect(saveSnapshot(company.id)).toEqual(before);
  });

  it.each(["unreadable metadata", "directory mismatch"])(
    "starts no company when another save has %s",
    (failure) => {
      const older = found({ mode: "capped", capUsd: 0 });
      const employee = store.createEmployee({ companyId: older.id, ...hire("Priya") });
      const task = store.createTask({ companyId: older.id, title: "Waiting" });
      store.claimTask(task.id, employee.id);
      copyCompany(older.id, "broken", older.createdAt + 1);
      const file = join(root, "broken", "COMPANY.md");
      const doc = parseDoc(readFileSync(file, "utf8"));
      writeFileSync(
        file,
        failure === "unreadable metadata"
          ? "corrupt company file"
          : serializeDoc({ ...doc, fields: { ...doc.fields, slug: older.id } }),
      );
      const before = saveSnapshot(older.id);

      const report = store.initStore();

      expect(report.companies).toBe(0);
      expect(report.skipped).toEqual([expect.objectContaining({ kind: "company", path: file })]);
      expect(store.getDefaultCompany()).toBeNull();
      expect(store.listQueuedTasks()).toEqual([]);
      scheduler.tick();
      expect(() => found()).toThrow("loaded or repaired");
      expect(saveSnapshot(older.id)).toEqual(before);
    },
  );
});
