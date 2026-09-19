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
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Budget } from "@/shared/domain";
import { parseDoc, reqStr, serializeDoc } from "./frontmatter";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-store-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("./store");
const { scheduler } = await import("@/main/scheduler");
const { productWorkspace, productsDir, shippedDir, tasksDir } = await import("@/main/paths");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env["IDLEBIZ_ROOT_DIR"];
  } else {
    process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
  }
});

const hire = (name: string) =>
  ({
    deskIndex: 0,
    name,
    persona: "ships",
    role: "engineer",
    runner: "claude",
    spriteSeed: name,
    title: "Engineer",
  }) as const;

const found = (budget?: Budget) =>
  store.foundCompany({
    budget: budget ?? { mode: "infinite" },
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [],
    mission: "ship",
    name: "Acme",
  });

const finish = (taskId: string, employeeId: string, summary: string): void => {
  store.claimTask(taskId, employeeId);
  store.lockTaskForRun(taskId, "run-1");
  store.settleTask(taskId, "run-1", { kind: "done", summary });
};

const copyCompany = (from: string, to: string, createdAt: number): void => {
  cpSync(path.join(root, from), path.join(root, to), { recursive: true });
  const file = path.join(root, to, "COMPANY.md");
  const doc = parseDoc(readFileSync(file, "utf-8"));
  writeFileSync(
    file,
    serializeDoc({
      ...doc,
      fields: { ...doc.fields, slug: to },
      metadata: { ...doc.metadata, createdAt },
    }),
  );
  for (const slug of readdirSync(path.join(root, to, "products"))) {
    const productFile = path.join(root, to, "products", slug, "PRODUCT.md");
    const product = parseDoc(readFileSync(productFile, "utf-8"));
    const workspaceDir = reqStr(product.metadata, "workspaceDir").replace(
      path.join(root, from),
      path.join(root, to),
    );
    writeFileSync(
      productFile,
      serializeDoc({ ...product, metadata: { ...product.metadata, workspaceDir } }),
    );
  }
};

const saveSnapshot = (companyId: string): Map<string, string> => {
  const dir = path.join(root, companyId);
  return new Map(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(dir, file), readFileSync(file, "utf-8")];
      }),
  );
};

describe("the shipping log", () => {
  it("moves a task that settles done out of the open queue into shipped/", () => {
    const co = found();
    const emp = store.createEmployee({ companyId: co.id, ...hire("Priya") });
    const task = store.createTask({ companyId: co.id, title: "Ship it" });
    finish(task.id, emp.id, "shipped");

    expect(existsSync(path.join(tasksDir(co.id), task.id))).toBe(false);
    expect(existsSync(path.join(shippedDir(co.id), task.id, "TASK.md"))).toBe(true);
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
    const legacyPkg = path.join(shippedDir(co.id), legacy.id);
    renameSync(legacyPkg, path.join(tasksDir(co.id), legacy.id));

    store.initStore();
    expect(existsSync(path.join(tasksDir(co.id), legacy.id))).toBe(false);
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
    expect(existsSync(path.join(productsDir(co.id), first?.id ?? "", "PRODUCT.md"))).toBe(true);
  });

  it("gives a later product its own workspace and tells every agent about it", () => {
    const co = found();
    const emp = store.createEmployee({ companyId: co.id, ...hire("Quinn") });
    const gadget = store.createProduct({
      companyId: co.id,
      description: "A second thing.",
      name: "Gadget",
    });
    expect(gadget.workspaceDir).toBe(productWorkspace(co.id, gadget.id));
    expect(existsSync(gadget.workspaceDir)).toBe(true);
    expect(store.employeeInstructions(emp.id)).toContain(gadget.workspaceDir);
    expect(store.attentionProduct(co.id)?.id).toBe(store.listProducts(co.id)[0]?.id);
  });

  it("attributes a ship to the product the task named, and turns autopilot to the other", () => {
    const co = found();
    const emp = store.createEmployee({ companyId: co.id, ...hire("Ravi") });
    const [first] = store.listProducts(co.id);
    const gadget = store.createProduct({ companyId: co.id, description: "x", name: "Gadget" });
    const task = store.createTask({ companyId: co.id, productId: gadget.id, title: "Ship it" });
    finish(task.id, emp.id, "done");
    store.recordShip(co.id, task.productId, "shipped");
    expect(store.getProduct(gadget.id)?.ships).toBe(1);
    expect(store.getProduct(first?.id ?? "")?.ships).toBe(0);
    expect(store.getCompany(co.id)?.ships).toBe(1);
    expect(store.attentionProduct(co.id)?.id).toBe(first?.id);
    expect(store.listShippedTasks(co.id)[0]?.productId).toBe(gadget.id);
  });

  it("gives a company from before products its one product, with the binding metrics.json held", () => {
    const co = found();
    // the save as an older build left it: no products/, a Vercel binding in metrics.json
    rmSync(productsDir(co.id), { force: true, recursive: true });
    mkdirSync(path.join(root, co.id), { recursive: true });
    writeFileSync(
      path.join(root, co.id, "metrics.json"),
      JSON.stringify({ vercel: { projectId: "prj_old", projectName: "old", teamId: "team_9" } }),
    );
    store.initStore();
    const [first] = store.listProducts(co.id);
    expect(first?.workspaceDir).toBe(co.workspaceDir);
    expect(first?.vercel).toEqual({ projectId: "prj_old", projectName: "old", teamId: "team_9" });
    expect(readFileSync(path.join(root, co.id, "metrics.json"), "utf-8")).not.toContain("prj_old");
  });
});

describe("scheduler queue admission", () => {
  it("leaves capped work queued without spinning on its first task", () => {
    const company = found({ capUsd: 0, mode: "capped" });
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
    const company = found({ capUsd: 0, mode: "capped" });
    const employee = store.createEmployee({ companyId: company.id, ...hire("Priya") });
    const orphan = store.createTask({ companyId: company.id, priority: "high", title: "Orphan" });
    const task = store.createTask({ companyId: company.id, title: "Waiting" });
    store.claimTask(orphan.id, "missing-employee");
    store.claimTask(task.id, employee.id);

    scheduler.tick();

    expect(store.listQueuedTasks().map((queued) => queued.id)).toEqual([orphan.id, task.id]);
    expect(store.getCompany(company.id)?.autopilot).toBe(false);
    expect(store.getEmployee(employee.id)?.status).toBe("idle");
  });
});

describe("founding publication", () => {
  it("publishes the complete roster, products, and routines using final workspace paths", () => {
    const company = store.foundCompany({
      budget: { capUsd: 0, mode: "capped" },
      businessType: "game-studio",
      founderName: "Kai",
      founderSpriteSeed: "seed",
      hires: [hire("Priya"), { ...hire("Mae"), role: "lead", title: "Team lead" }],
      mission: "ship",
      name: "Acme",
    });
    const files = saveSnapshot(company.id);

    expect(files.has("COMPANY.md")).toBe(true);
    expect(files.has("products/acme/PRODUCT.md")).toBe(true);
    expect(files.has("agents/priya/AGENTS.md")).toBe(true);
    expect(files.has("agents/mae/AGENTS.md")).toBe(true);
    expect(files.has("routines/business-review/ROUTINE.md")).toBe(true);
    expect(files.has("routines/marketing-push/ROUTINE.md")).toBe(true);
    expect(files.has("routines/playtest-session/ROUTINE.md")).toBe(true);
    expect(files.get("agents/mae/AGENTS.md")).toContain("**hire**");
    for (const body of files.values()) {
      expect(body).not.toContain(".founding-");
    }
    const product = parseDoc(files.get("products/acme/PRODUCT.md") ?? "");
    expect(product.metadata.workspaceDir).toBe(path.join(root, company.id, "workspace"));
    expect(files.get("agents/priya/AGENTS.md")).toContain(path.join(root, company.id, "workspace"));
    expect(readdirSync(root).filter((entry) => entry.startsWith(".founding-"))).toEqual([]);

    expect(store.initStore()).toEqual({ companies: 1, skipped: [] });
    expect(store.getDefaultCompany()?.leaderId).toBe("mae");
    expect(
      store
        .listEmployees(company.id)
        .map((employee) => employee.id)
        .toSorted(),
    ).toEqual(["mae", "priya"]);
    expect(store.listRoutines(company.id)).toHaveLength(3);
  });

  it.each([false, true])(
    "ignores an interrupted stage with COMPANY.md present: %s",
    (hasCompanyFile) => {
      const staging = ".founding-interrupted";
      mkdirSync(path.join(root, staging, "agents", "priya"), { recursive: true });
      writeFileSync(path.join(root, staging, "agents", "priya", "AGENTS.md"), "partial employee");
      if (hasCompanyFile) {
        writeFileSync(
          path.join(root, staging, "COMPANY.md"),
          serializeDoc({
            body: "",
            fields: { name: "Acme", slug: "acme" },
            metadata: { createdAt: 1 },
          }),
        );
      }
      const before = saveSnapshot(staging);

      expect(store.initStore()).toEqual({ companies: 0, skipped: [] });
      expect(store.getDefaultCompany()).toBeNull();
      expect(existsSync(path.join(root, "acme"))).toBe(false);

      const company = found({ capUsd: 0, mode: "capped" });

      expect(company.id).toBe("acme");
      expect(store.getDefaultCompany()?.id).toBe(company.id);
      expect(existsSync(path.join(root, company.id, "COMPANY.md"))).toBe(true);
      expect(saveSnapshot(staging)).toEqual(before);
      expect(readdirSync(root).filter((entry) => entry.startsWith(".founding-"))).toEqual([
        staging,
      ]);
    },
  );
});

describe("active company ownership", () => {
  it("confines duplicate employee, task, and product slugs to the newest company", () => {
    const older = found({ capUsd: 0, mode: "capped" });
    const employee = store.createEmployee({ companyId: older.id, ...hire("Priya") });
    const [product] = store.listProducts(older.id);
    if (!product) {
      throw new Error("founding must create a product");
    }
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

    store.noteRunEnd(employee.id, "new-session");
    store.setProductVercel(product.id, {
      projectId: "new-project",
      projectName: "New",
      teamId: null,
    });
    store.lockTaskForRun(queued.id, "new-run");
    store.settleTask(queued.id, "new-run", { kind: "done", summary: "new company shipped" });
    store.recordShip("newer", product.id, "new company shipped");
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
    expect(store.recentShips(older.id)).toEqual([]);
    expect(() => store.setAutopilot(older.id, false)).toThrow("not active");
    expect(() => store.createEmployee({ companyId: older.id, ...hire("Someone") })).toThrow(
      "not active",
    );
    expect(() =>
      store.createProduct({ companyId: older.id, description: "No", name: "No" }),
    ).toThrow("not active");
    expect(() => store.createTask({ companyId: older.id, title: "No" })).toThrow("not active");
    expect(() => store.postTeamMessage(older.id, null, "No")).toThrow("not active");
    expect(() => store.grantApproval(older.id, "new command")).toThrow("not active");
    expect(() => store.consumeApproval(older.id, "old command")).toThrow("not active");
    expect(store.recordSpend(older.id, 10)).toBeNull();
    expect(store.setRealMetrics(older.id, { revenue: 10, users: 10 })).toBeNull();
    store.recordShip(older.id, "acme", "shipped");
    store.markRoutineRun(older.id, "business-review");
    expect(saveSnapshot(older.id)).toEqual(before);
  });

  it("does not migrate an inactive legacy save", () => {
    const older = found();
    copyCompany(older.id, "newer", older.createdAt + 1);
    rmSync(path.join(root, older.id, "products"), { recursive: true });
    rmSync(path.join(root, older.id, "routines"), { recursive: true });
    writeFileSync(
      path.join(root, older.id, "metrics.json"),
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
    expect(existsSync(path.join(root, "acme-2"))).toBe(false);
    expect(saveSnapshot(company.id)).toEqual(before);
  });

  it.each(["unreadable metadata", "directory mismatch"])(
    "starts no company when another save has %s",
    (failure) => {
      const older = found({ capUsd: 0, mode: "capped" });
      const employee = store.createEmployee({ companyId: older.id, ...hire("Priya") });
      const task = store.createTask({ companyId: older.id, title: "Waiting" });
      store.claimTask(task.id, employee.id);
      copyCompany(older.id, "broken", older.createdAt + 1);
      const file = path.join(root, "broken", "COMPANY.md");
      const doc = parseDoc(readFileSync(file, "utf-8"));
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

describe("the digest", () => {
  it("folds what happens after a look, and reading it is the next look", () => {
    const company = found();
    expect(store.digest(company.id)).toBeNull();
    store.logActivity({ createdAt: 1, kind: "ship", message: "v0 shipped" }, true);
    store.logActivity(
      {
        createdAt: 2,
        kind: "run.end",
        payload: { costUsd: 0.25, outcome: { kind: "done" }, summary: "done" },
      },
      true,
    );
    store.logActivity(
      { createdAt: 3, kind: "org.hired", payload: { by: "lead", name: "Mira", title: "PM" } },
      true,
    );
    store.logActivity(
      { createdAt: 4, kind: "task.dead", payload: { attempts: 3, error: "boom" } },
      true,
    );
    store.logActivity({ createdAt: 5, kind: "message", message: "not counted" }, true);

    expect(store.digest(company.id)).toMatchObject({
      dead: 1,
      hired: ["Mira"],
      released: [],
      runs: 1,
      shipped: 1,
      ships: ["v0 shipped"],
      spentUsd: 0.25,
    });
    expect(store.digest(company.id)).toMatchObject({ runs: 0, shipped: 0, ships: [] });
  });

  it("survives a restart mid-absence", () => {
    const company = found();
    store.markSeen(company.id, 1234);
    store.logActivity({ createdAt: 2000, kind: "ship", message: "while closed" }, true);
    store.initStore();
    expect(store.digest(company.id)).toMatchObject({ ships: ["while closed"], since: 1234 });
  });
});

describe("what a run leaves behind", () => {
  it("is kept beside the agent, never in its instructions, and survives a restart", () => {
    const company = found();
    const emp = store.createEmployee({ ...hire("Priya"), companyId: company.id });
    const instructions = path.join(root, company.id, "agents", emp.id, "AGENTS.md");
    const before = readFileSync(instructions, "utf-8");
    store.setRealMetrics(company.id, { revenue: 12.5, users: null });

    store.noteRunEnd(emp.id, "session-1");

    expect(readFileSync(instructions, "utf-8")).toBe(before);
    store.initStore();
    expect(store.getEmployee(emp.id)).toMatchObject({
      lastRunMetrics: { revenueUsd: 12.5, users: null },
      sessionId: "session-1",
    });
  });

  it("still resumes a session a save from before run-state.json kept in AGENTS.md", () => {
    const company = found();
    const emp = store.createEmployee({ ...hire("Priya"), companyId: company.id });
    const instructions = path.join(root, company.id, "agents", emp.id, "AGENTS.md");
    const doc = parseDoc(readFileSync(instructions, "utf-8"));
    writeFileSync(
      instructions,
      serializeDoc({ ...doc, metadata: { ...doc.metadata, sessionId: "legacy-session" } }),
    );
    store.initStore();
    expect(store.getEmployee(emp.id)?.sessionId).toBe("legacy-session");
  });
});

describe("recently shipped", () => {
  it("keeps the latest summaries for the next brief, across a restart", () => {
    const company = found();
    for (let i = 0; i < 8; i += 1) {
      store.recordShip(company.id, null, `ship ${i}`);
    }
    store.initStore();
    expect(store.recentShips(company.id)).toEqual(
      Array.from({ length: 6 }, (_, i) => `ship ${i + 2}`),
    );
  });
});
