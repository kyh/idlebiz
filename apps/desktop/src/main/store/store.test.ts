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
import { parseDoc, reqNum, reqStr, serializeDoc } from "./frontmatter";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-store-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("./store");
const { scheduler } = await import("@/main/scheduler");
const { alumniDir, betFile, productWorkspace, productsDir, retiredDir, shippedDir, tasksDir } =
  await import("@/main/paths");

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

/** Take the stamp off, as a save from before saves were stamped. */
const unstamp = (companyId: string): void => {
  const file = path.join(root, companyId, "COMPANY.md");
  writeFileSync(file, readFileSync(file, "utf-8").replace(/\n {2}format: \d+/u, ""));
};

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
    const emp = store.createEmployee({ ...hire("Priya") });
    const task = store.createTask({ title: "Ship it" });
    finish(task.id, emp.id, "shipped");

    expect(existsSync(path.join(tasksDir(co.id), task.id))).toBe(false);
    expect(existsSync(path.join(shippedDir(co.id), task.id, "TASK.md"))).toBe(true);
    expect(store.listOpenTasks()).toEqual([]);
    expect(store.getTask(task.id)).toBeNull();
    expect(store.listShippedTasks().map((t) => t.id)).toEqual([task.id]);
  });

  it("reads the shipping log from disk only when asked, and boot shelves done work left in the queue", () => {
    const co = found();
    const emp = store.createEmployee({ ...hire("Sana") });
    const shipped = store.createTask({ title: "Done before" });
    finish(shipped.id, emp.id, "one");
    const open = store.createTask({ title: "Still open" });

    // a save from before shipped/ existed: a done package still under tasks/
    const legacy = store.createTask({ title: "Legacy done" });
    store.claimTask(legacy.id, emp.id);
    store.lockTaskForRun(legacy.id, "run-2");
    store.settleTask(legacy.id, "run-2", { kind: "done", summary: "two" });
    const legacyPkg = path.join(shippedDir(co.id), legacy.id);
    renameSync(legacyPkg, path.join(tasksDir(co.id), legacy.id));

    store.initStore();
    expect(existsSync(path.join(tasksDir(co.id), legacy.id))).toBe(false);
    expect(existsSync(legacyPkg)).toBe(true);
    expect(store.listOpenTasks().map((t) => t.id)).toEqual([open.id]);
    expect(
      store
        .listShippedTasks()
        .map((t) => t.id)
        .toSorted(),
    ).toEqual([legacy.id, shipped.id].toSorted());
  });

  it("never hands a new task a slug the shipping log already holds", () => {
    found();
    const emp = store.createEmployee({ ...hire("Wren") });
    const first = store.createTask({ title: "Same title" });
    finish(first.id, emp.id, "done");
    const second = store.createTask({ title: "Same title" });
    expect(second.id).not.toBe(first.id);
  });
});

describe("products", () => {
  it("founds a company with its first product, born in the company workspace", () => {
    const co = found();
    const [first, ...rest] = store.listProducts();
    expect(rest).toEqual([]);
    expect(first?.name).toBe(co.name);
    expect(first?.workspaceDir).toBe(co.workspaceDir);
    expect(existsSync(path.join(productsDir(co.id), first?.id ?? "", "PRODUCT.md"))).toBe(true);
  });

  it("gives a later product its own workspace and tells every agent about it", () => {
    const co = found();
    const emp = store.createEmployee({ ...hire("Quinn") });
    const gadget = store.createProduct({
      description: "A second thing.",
      name: "Gadget",
    });
    expect(gadget.workspaceDir).toBe(productWorkspace(co.id, gadget.id));
    expect(existsSync(gadget.workspaceDir)).toBe(true);
    expect(store.employeeInstructions(emp.id)).toContain(gadget.workspaceDir);
    expect(store.attentionProduct()?.id).toBe(store.listProducts()[0]?.id);
  });

  it("attributes a ship to the product the task named, and turns autopilot to the other", () => {
    found();
    const emp = store.createEmployee({ ...hire("Ravi") });
    const [first] = store.listProducts();
    const gadget = store.createProduct({ description: "x", name: "Gadget" });
    const task = store.createTask({ productId: gadget.id, title: "Ship it" });
    finish(task.id, emp.id, "done");
    store.recordShip(task.productId, "shipped");
    expect(store.getProduct(gadget.id)?.ships).toBe(1);
    expect(store.getProduct(first?.id ?? "")?.ships).toBe(0);
    expect(store.getCompany()?.ships).toBe(1);
    expect(store.attentionProduct()?.id).toBe(first?.id);
    expect(store.listShippedTasks()[0]?.productId).toBe(gadget.id);
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
    unstamp(co.id);
    store.initStore();
    const [first] = store.listProducts();
    expect(first?.workspaceDir).toBe(co.workspaceDir);
    expect(first?.vercel).toEqual({ projectId: "prj_old", projectName: "old", teamId: "team_9" });
    expect(readFileSync(path.join(root, co.id, "metrics.json"), "utf-8")).not.toContain("prj_old");
  });
});

describe("scheduler queue admission", () => {
  it("leaves capped work queued without spinning on its first task", () => {
    found({ capUsd: 0, mode: "capped" });
    const employee = store.createEmployee({ ...hire("Priya") });
    const teammate = store.createEmployee({ ...hire("Sana") });
    const task = store.createTask({ title: "First task" });
    const next = store.createTask({ title: "Next task" });
    store.claimTask(task.id, employee.id);
    store.claimTask(next.id, teammate.id);

    scheduler.tick();

    expect(store.getCompany()?.autopilot).toBe(false);
    expect(store.listQueuedTasks().map((queued) => queued.id)).toEqual([task.id, next.id]);
    expect(store.getEmployee(employee.id)?.status).toBe("idle");
    expect(store.getEmployee(teammate.id)?.status).toBe("idle");
  });

  it("skips a missing assignee and still checks later work", () => {
    found({ capUsd: 0, mode: "capped" });
    const employee = store.createEmployee({ ...hire("Priya") });
    const orphan = store.createTask({ priority: "high", title: "Orphan" });
    const task = store.createTask({ title: "Waiting" });
    store.claimTask(orphan.id, "missing-employee");
    store.claimTask(task.id, employee.id);

    scheduler.tick();

    expect(store.listQueuedTasks().map((queued) => queued.id)).toEqual([orphan.id, task.id]);
    expect(store.getCompany()?.autopilot).toBe(false);
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
      hires: [{ ...hire("Mae"), role: "lead", title: "Team lead" }, hire("Priya")],
      mission: "ship",
      name: "Acme",
    });
    const files = saveSnapshot(company.id);

    expect(files.has("COMPANY.md")).toBe(true);
    expect(files.has("products/acme/PRODUCT.md")).toBe(true);
    expect(files.has("agents/priya/AGENTS.md")).toBe(true);
    expect(files.has("agents/mae/AGENTS.md")).toBe(true);
    expect(files.has("routines/business-review/ROUTINE.md")).toBe(false);
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
    expect(store.getCompany()?.leaderId).toBe("mae");
    expect(
      store
        .listEmployees()
        .map((employee) => employee.id)
        .toSorted(),
    ).toEqual(["mae", "priya"]);
    expect(store.listRoutines().map((r) => r.id)).toEqual(["playtest-session"]);
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
      expect(store.getCompany()).toBeNull();
      expect(existsSync(path.join(root, "acme"))).toBe(false);

      const company = found({ capUsd: 0, mode: "capped" });

      expect(company.id).toBe("acme");
      expect(store.getCompany()?.id).toBe(company.id);
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
    const employee = store.createEmployee({ ...hire("Priya") });
    const [product] = store.listProducts();
    if (!product) {
      throw new Error("founding must create a product");
    }
    const queued = store.createTask({ title: "Ship it" });
    store.claimTask(queued.id, employee.id);
    const running = store.createTask({ title: "In flight" });
    store.claimTask(running.id, employee.id);
    store.lockTaskForRun(running.id, "old-run");
    store.postTeamMessage(employee.id, "existing room history");
    copyCompany(older.id, "newer", older.createdAt + 1);
    const oldOnly = store.createEmployee({ ...hire("Old only") });
    const oldTask = store.createTask({ title: "Old only" });
    store.claimTask(oldTask.id, oldOnly.id);
    const before = saveSnapshot(older.id);

    expect(store.initStore()).toEqual({ companies: 1, skipped: [] });
    expect(store.getCompany()?.id).toBe("newer");
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
    store.recordShip(product.id, "new company shipped");
    scheduler.tick();

    expect(store.getEmployee(employee.id)?.sessionId).toBe("new-session");
    expect(store.getProduct(product.id)?.ships).toBe(1);
    expect(store.listShippedTasks().map((task) => task.id)).toEqual([queued.id]);
    expect(saveSnapshot(older.id)).toEqual(before);
  });

  it("cannot reach an inactive save: whatever the API does lands on the newest company", () => {
    const older = found();
    copyCompany(older.id, "newer", older.createdAt + 1);
    const before = saveSnapshot(older.id);
    store.initStore();

    store.setAutopilot(false);
    store.createEmployee(hire("Someone"));
    store.createProduct({ description: "Another", name: "Another" });
    store.createTask({ title: "Work" });
    store.postTeamMessage(null, "hello");
    store.grantApproval("some-task", "a command");
    store.recordSpend(10);
    store.setRealMetrics({ revenue: 10, users: 10 });
    store.recordShip(null, "shipped");

    expect(store.getCompany()).toMatchObject({ id: "newer", spentUsd: 10 });
    expect(saveSnapshot(older.id)).toEqual(before);
  });

  it("refuses to act with no company loaded", () => {
    expect(store.getCompany()).toBeNull();
    expect(store.getEmployee("nobody")).toBeNull();
    expect(store.listQueuedTasks()).toEqual([]);
    expect(() => store.listEmployees()).toThrow("no company is loaded");
    expect(() => store.createTask({ title: "No" })).toThrow("no company is loaded");
  });

  it("does not migrate an inactive legacy save", () => {
    const older = found();
    copyCompany(older.id, "newer", older.createdAt + 1);
    rmSync(path.join(root, older.id, "products"), { recursive: true });
    writeFileSync(
      path.join(root, older.id, "metrics.json"),
      JSON.stringify({ vercel: { projectId: "old" } }),
    );
    const before = saveSnapshot(older.id);

    store.initStore();

    expect(store.getCompany()?.id).toBe("newer");
    expect(saveSnapshot(older.id)).toEqual(before);
  });

  it("breaks equal creation timestamps by slug", () => {
    const first = found();
    copyCompany(first.id, "z-last", first.createdAt + 1);
    copyCompany(first.id, "a-first", first.createdAt + 1);

    store.initStore();
    expect(store.getCompany()?.id).toBe("a-first");
    store.initStore();
    expect(store.getCompany()?.id).toBe("a-first");
  });

  it("rejects a second founding without touching the active save", () => {
    const company = found();
    const before = saveSnapshot(company.id);

    expect(() => found()).toThrow("already active");

    expect(store.getCompany()?.id).toBe(company.id);
    expect(existsSync(path.join(root, "acme-2"))).toBe(false);
    expect(saveSnapshot(company.id)).toEqual(before);
  });

  it.each(["unreadable metadata", "directory mismatch"])(
    "starts no company when another save has %s",
    (failure) => {
      const older = found({ capUsd: 0, mode: "capped" });
      const employee = store.createEmployee({ ...hire("Priya") });
      const task = store.createTask({ title: "Waiting" });
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
      expect(store.getCompany()).toBeNull();
      expect(store.listQueuedTasks()).toEqual([]);
      scheduler.tick();
      expect(() => found()).toThrow("loaded or repaired");
      expect(saveSnapshot(older.id)).toEqual(before);
    },
  );
});

describe("the digest", () => {
  it("folds what happens after a look, and reading it is the next look", () => {
    found();
    expect(store.takeDigest()).toBeNull();
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

    expect(store.takeDigest()).toMatchObject({
      dead: 1,
      hired: ["Mira"],
      released: [],
      runs: 1,
      shipped: 1,
      ships: ["v0 shipped"],
      spentUsd: 0.25,
    });
    expect(store.takeDigest()).toMatchObject({ runs: 0, shipped: 0, ships: [] });
  });

  it("survives a restart mid-absence", () => {
    found();
    store.markSeen(1234);
    store.logActivity({ createdAt: 2000, kind: "ship", message: "while closed" }, true);
    store.initStore();
    expect(store.takeDigest()).toMatchObject({ ships: ["while closed"], since: 1234 });
  });
});

describe("what a run leaves behind", () => {
  it("is kept beside the agent, never in its instructions, and survives a restart", () => {
    const company = found();
    const emp = store.createEmployee(hire("Priya"));
    const instructions = path.join(root, company.id, "agents", emp.id, "AGENTS.md");
    const before = readFileSync(instructions, "utf-8");
    store.setRealMetrics({ revenue: 12.5, users: null });

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
    const emp = store.createEmployee(hire("Priya"));
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
      store.recordShip(null, `ship ${i}`);
    }
    store.markSeen(1);
    expect(readdirSync(path.join(root, company.id, "state")).toSorted()).toEqual([
      "recent-ships.json",
      "since-last-look.json",
    ]);
    store.initStore();
    expect(store.recentShips()).toEqual(Array.from({ length: 6 }, (_, i) => `ship ${i + 2}`));
  });
});

const launch = (productId: string) =>
  store.openBet({
    budgetUsd: 2,
    hypothesis: "a launch post brings visitors",
    landingPath: null,
    metric: "users",
    productId,
    target: 50,
    title: "Launch post",
    windowHours: 24,
  });

const firstProduct = () => {
  const [product] = store.listProducts();
  if (!product) {
    throw new Error("no first product");
  }
  return product;
};

describe("bets", () => {
  it("gives a users bet a path of its own and refuses one another bet already covers", () => {
    found();
    const product = firstProduct();
    const bet = launch(product.id);
    expect(bet).toMatchObject({
      claim: { landingPath: `/b/${bet.id}`, metric: "users" },
      reading: null,
      state: { kind: "open" },
    });
    expect(launch(product.id).id).not.toBe(bet.id);
    expect(() =>
      store.openBet({
        budgetUsd: 2,
        hypothesis: "the whole site grows",
        landingPath: "/",
        metric: "users",
        productId: product.id,
        target: 50,
        title: "Everything",
        windowHours: 24,
      }),
    ).toThrow("could not be told apart");
  });

  it("is judged by what it brought in, and the verdict survives a restart", () => {
    const co = found();
    const bet = launch(firstProduct().id);
    store.recordBetSpend(bet.id, 2);
    expect(store.judgeBets(0)).toEqual([]);
    expect(store.measureBet(bet.id, 0).state.kind).toBe("measuring");
    store.setBetReading(bet.id, 60);
    store.setBetReading(bet.id, null);
    expect(store.judgeBets(1).map((b) => b.state.kind)).toEqual(["won"]);
    expect(store.judgeBets(2)).toEqual([]);
    expect(existsSync(betFile(co.id, bet.id))).toBe(true);
    store.initStore();
    expect(store.getBet(bet.id)).toMatchObject({
      reading: 60,
      spentUsd: 2,
      state: { kind: "won", moved: 60 },
    });
  });

  it("retires a product with its bets and open work, but never the last one", () => {
    const co = found();
    const first = firstProduct();
    expect(() => store.killProduct(first.id, "dud")).toThrow("only product");
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const bet = launch(side.id);
    const task = store.createTask({
      betId: bet.id,
      productId: side.id,
      title: "Post",
    });
    expect(store.killProduct(side.id, "no traction").map((b) => b.id)).toEqual([bet.id]);
    expect(store.listProducts().map((p) => p.id)).toEqual([first.id]);
    expect(store.getBet(bet.id)?.state).toMatchObject({ kind: "killed" });
    expect(store.getTask(task.id)?.state.kind).toBe("dead");
    expect(existsSync(path.join(retiredDir(co.id), side.id, "PRODUCT.md"))).toBe(true);
    expect(existsSync(path.join(productsDir(co.id), side.id))).toBe(false);
    store.initStore();
    expect(store.listProducts().map((p) => p.id)).toEqual([first.id]);
  });
});

describe("archives", () => {
  it("keep a released employee's slug, so a namesake's release sticks across a restart", () => {
    const co = found();
    const first = store.createEmployee({ ...hire("Priya") });
    store.archiveEmployee(first.id);
    const second = store.createEmployee({ ...hire("Priya") });
    expect(second.id).toBe(`${first.id}-2`);
    store.archiveEmployee(second.id);
    store.initStore();
    expect(store.listEmployees()).toEqual([]);
    expect(existsSync(path.join(alumniDir(co.id), first.id, "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(alumniDir(co.id), second.id, "AGENTS.md"))).toBe(true);
  });

  it("keep a retired product's slug, so a namesake's retirement sticks across a restart", () => {
    const co = found();
    const first = firstProduct();
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    store.killProduct(side.id, "dud");
    const again = store.createProduct({ description: "a second try", name: "Side" });
    expect(again.id).toBe(`${side.id}-2`);
    store.killProduct(again.id, "dud again");
    store.initStore();
    expect(store.listProducts().map((p) => p.id)).toEqual([first.id]);
    expect(existsSync(path.join(retiredDir(co.id), side.id, "PRODUCT.md"))).toBe(true);
    expect(existsSync(path.join(retiredDir(co.id), again.id, "PRODUCT.md"))).toBe(true);
  });

  it("archive beside a namesake a save already holds, so the release sticks across a restart", () => {
    const co = found();
    const first = firstProduct();
    const emp = store.createEmployee({ ...hire("Priya") });
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const earlier = [path.join(alumniDir(co.id), emp.id), path.join(retiredDir(co.id), side.id)];
    for (const taken of earlier) {
      mkdirSync(taken, { recursive: true });
      writeFileSync(path.join(taken, "README.md"), "someone else's");
    }
    store.archiveEmployee(emp.id);
    store.killProduct(side.id, "dud");
    store.initStore();
    expect(store.listEmployees()).toEqual([]);
    expect(store.listProducts().map((p) => p.id)).toEqual([first.id]);
    expect(existsSync(path.join(alumniDir(co.id), `${emp.id}-2`, "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(retiredDir(co.id), `${side.id}-2`, "PRODUCT.md"))).toBe(true);
    for (const taken of earlier) {
      expect(readFileSync(path.join(taken, "README.md"), "utf-8")).toBe("someone else's");
    }
  });

  it("refuse a release or a retirement the move cannot make, and nothing leaves", () => {
    const co = found();
    const emp = store.createEmployee({ ...hire("Priya") });
    const task = store.createTask({ assigneeId: emp.id, title: "Ship it" });
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const bet = launch(side.id);
    for (const archive of [alumniDir(co.id), retiredDir(co.id)]) {
      writeFileSync(archive, "not a directory");
    }
    expect(() => store.archiveEmployee(emp.id)).toThrow();
    expect(() => store.killProduct(side.id, "dud")).toThrow();
    expect(store.listEmployees().map((e) => e.id)).toEqual([emp.id]);
    expect(store.getTask(task.id)?.assigneeId).toBe(emp.id);
    expect(store.getProduct(side.id)).not.toBeNull();
    expect(store.getBet(bet.id)?.state.kind).toBe("open");
  });
});

describe("retired routines", () => {
  it("leaves a save at boot, and hand-written routines stay", () => {
    const co = found();
    const write = (slug: string) => {
      const dir = path.join(root, co.id, "routines", slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "ROUTINE.md"),
        serializeDoc({
          body: "do it\n",
          fields: { kind: "routine", name: slug, schema: "agentcompanies/v1", slug },
          metadata: { intervalHours: 24 },
        }),
      );
    };
    write("business-review");
    write("weekly-backup");
    unstamp(co.id);

    store.initStore();

    expect(store.listRoutines().map((r) => r.id)).toEqual(["weekly-backup"]);
    expect(existsSync(path.join(root, co.id, "routines", "business-review"))).toBe(false);
  });
});

describe("founder approvals", () => {
  it("belong to the task they were given for, once", () => {
    found();
    store.grantApproval("continue-deploy", "vercel deploy --prod");
    expect(store.consumeApproval("someone-elses-task", "vercel deploy --prod")).toBe(false);
    expect(store.consumeApproval("continue-deploy", "vercel deploy")).toBe(false);
    expect(store.consumeApproval("continue-deploy", "vercel deploy --prod")).toBe(true);
    expect(store.consumeApproval("continue-deploy", "vercel deploy --prod")).toBe(false);
  });

  it("leave with a task that ended without using them", () => {
    found();
    store.grantApproval("continue-deploy", "vercel deploy --prod");
    store.revokeApprovals("continue-deploy");
    expect(store.consumeApproval("continue-deploy", "vercel deploy --prod")).toBe(false);
  });

  it("ignore the company-wide grants older saves kept", () => {
    const co = found();
    writeFileSync(path.join(root, co.id, "approvals.json"), JSON.stringify(["git push"]));
    store.initStore();
    expect(store.consumeApproval("any-task", "git push")).toBe(false);
  });
});

const stampOf = (companyId: string): number =>
  reqNum(
    parseDoc(readFileSync(path.join(root, companyId, "COMPANY.md"), "utf-8")).metadata,
    "format",
  );

describe("the save format", () => {
  it("stamps what it writes", () => {
    expect(stampOf(found().id)).toBe(1);
  });

  it("refuses a save a newer build wrote, and leaves it as it found it", () => {
    const co = found();
    const file = path.join(root, co.id, "COMPANY.md");
    writeFileSync(file, readFileSync(file, "utf-8").replace("format: 1", "format: 99"));
    const before = saveSnapshot(co.id);

    const report = store.initStore();

    expect(report.companies).toBe(0);
    expect(report.skipped[0]).toMatchObject({ kind: "company" });
    expect(report.skipped[0]?.error).toContain("newer IdleBiz");
    expect(store.getCompany()).toBeNull();
    expect(saveSnapshot(co.id)).toEqual(before);
  });

  it("adopts an unstamped save once, and only once", () => {
    const co = found();
    unstamp(co.id);
    const retired = path.join(root, co.id, "routines", "business-review");
    const seed = (): void => {
      mkdirSync(retired, { recursive: true });
      writeFileSync(
        path.join(retired, "ROUTINE.md"),
        serializeDoc({
          body: "review\n",
          fields: { kind: "routine", name: "Business review", slug: "business-review" },
          metadata: { intervalHours: 24 },
        }),
      );
    };
    seed();

    store.initStore();
    expect(existsSync(retired)).toBe(false);
    expect(stampOf(co.id)).toBe(1);

    seed();
    store.initStore();
    expect(existsSync(retired)).toBe(true);
  });

  it("leaves alone a package written in a schema it does not read", () => {
    const co = found();
    const dir = path.join(root, co.id, "routines", "foreign");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "ROUTINE.md"),
      '---\nname: "Foreign"\nschema: "agentcompanies/v9"\nslug: "foreign"\nmetadata:\n  intervalHours: 1\n---\nhi\n',
    );
    const report = store.initStore();
    expect(report.skipped[0]?.error).toContain("agentcompanies/v9");
    expect(store.listRoutines().map((r) => r.id)).not.toContain("foreign");
  });
});
