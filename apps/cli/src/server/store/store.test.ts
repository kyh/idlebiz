import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UNNAMED_PRODUCT_DESCRIPTION } from "@repo/domain/domain";
import { RefusalError } from "../refusal";
import { parseDoc, serializeDoc } from "./frontmatter";
import { taskToDoc } from "./task-codec";
import * as store from "./store";
import { createScheduler } from "../scheduler";
import { runnerPool } from "../agents/runner-pool";
import {
  companyDir,
  companyFile,
  productsDir,
  sharedDir,
  shippedDir,
  tasksDir,
  employeeAgentDir,
  productWorkspace,
} from "../paths";
import { unaskedIntegrations } from "../test-support/integrations";
import { foundAcme, freshSave, hire } from "../test-support/save";
import { block, firstProduct, launch, recruit, stateOf, writeDead } from "../test-support/store";

const root = freshSave();
const asleep = { hold: () => {} };
/** The app's own runner, whose seal no test has checked: its ticks start nothing. */
const scheduler = createScheduler(runnerPool, asleep, unaskedIntegrations);

/** Stamp the save as another build would have written it. */
const restamp = (format: number): void => {
  writeFileSync(
    companyFile(),
    readFileSync(companyFile(), "utf-8").replace(/format: \d+/u, `format: ${format}`),
  );
};

const finish = (taskId: string, employeeId: string, summary: string): void => {
  store.claimTask(taskId, employeeId);
  store.lockTaskForRun(taskId, "run-1");
  store.settleTask(taskId, "run-1", { kind: "done", summary });
};

const saveSnapshot = (dir: string): Map<string, string> =>
  new Map(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(dir, file), readFileSync(file, "utf-8")];
      }),
  );

describe("the shipping log", () => {
  it("moves a task that settles done out of the open queue into shipped/", () => {
    foundAcme();
    const emp = store.createEmployee(recruit("Priya"));
    const task = store.createTask({ origin: "founder", title: "Ship it" });
    finish(task.id, emp.id, "shipped");

    expect(existsSync(path.join(tasksDir(), task.id))).toBe(false);
    expect(existsSync(path.join(shippedDir(), task.id, "TASK.md"))).toBe(true);
    expect(store.listOpenTasks()).toEqual([]);
    expect(store.getTask(task.id)).toBeNull();
    expect(store.listShippedTasks().map((t) => t.id)).toEqual([task.id]);
  });

  it("reads the shipping log from disk only when asked, and boot shelves done work left in the queue", () => {
    foundAcme();
    const emp = store.createEmployee(recruit("Sana"));
    const shipped = store.createTask({ origin: "founder", title: "Done before" });
    finish(shipped.id, emp.id, "one");
    const open = store.createTask({ origin: "founder", title: "Still open" });

    // a done package whose move to shipped/ failed, still under tasks/
    const stranded = store.createTask({ origin: "founder", title: "Stranded done" });
    store.claimTask(stranded.id, emp.id);
    store.lockTaskForRun(stranded.id, "run-2");
    store.settleTask(stranded.id, "run-2", { kind: "done", summary: "two" });
    const strandedPkg = path.join(shippedDir(), stranded.id);
    renameSync(strandedPkg, path.join(tasksDir(), stranded.id));

    store.initStore();
    expect(existsSync(path.join(tasksDir(), stranded.id))).toBe(false);
    expect(existsSync(strandedPkg)).toBe(true);
    expect(store.listOpenTasks().map((t) => t.id)).toEqual([open.id]);
    expect(
      store
        .listShippedTasks()
        .map((t) => t.id)
        .toSorted(),
    ).toEqual([stranded.id, shipped.id].toSorted());
  });

  it("never hands a new task a slug the shipping log already holds", () => {
    foundAcme();
    const emp = store.createEmployee(recruit("Wren"));
    for (const slug of ["same-title", "same-title-2"]) {
      const task = store.createTask({ origin: "founder", title: "Same title" });
      expect(task.id).toBe(slug);
      finish(task.id, emp.id, "done");
    }
    expect(store.createTask({ origin: "founder", title: "Same title" }).id).toBe("same-title-3");
  });
});

describe("products", () => {
  it("founds a company with its first product's code in its package and a shared/ beside it", () => {
    const co = foundAcme();
    const [first, ...rest] = store.listProducts();
    expect(rest).toEqual([]);
    expect(first?.name).toBe(co.name);
    expect(first?.workspaceDir).toBe(productWorkspace(first?.id ?? ""));
    expect(co.workspaceDir).toBe(sharedDir());
    expect(existsSync(first?.workspaceDir ?? "")).toBe(true);
    expect(existsSync(co.workspaceDir)).toBe(true);
    expect(existsSync(path.join(productsDir(), first?.id ?? "", "PRODUCT.md"))).toBe(true);
  });

  it("founds a company with no pitch, its first product left for the team to name", () => {
    foundAcme([], { mission: null });
    store.initStore();
    expect(store.getCompany()?.mission).toBeNull();
    expect(store.listProducts()[0]?.description).toBe(UNNAMED_PRODUCT_DESCRIPTION);
  });

  it("names a product the lead picked, keeping its slug, on disk and in every agent's instructions", () => {
    foundAcme();
    const emp = store.createEmployee(recruit("Quinn"));
    const [first] = store.listProducts();
    const id = first?.id ?? "";
    const named = store.nameProduct(id, {
      description: " Invoices that chase themselves. ",
      name: " Ledgerly ",
    });
    expect(named).toMatchObject({
      description: "Invoices that chase themselves.",
      id,
      name: "Ledgerly",
    });
    store.initStore();
    expect(store.getProduct(id)).toMatchObject({
      description: "Invoices that chase themselves.",
      name: "Ledgerly",
    });
    expect(store.employeeInstructions(emp.id)).toContain(
      `**Ledgerly** (\`${id}\`) — Invoices that chase themselves.`,
    );
  });

  it.each([
    ["an empty name", { description: "x", name: "  " }],
    ["a name past 80 characters", { description: "x", name: "n".repeat(81) }],
    ["an empty description", { description: "", name: "Ledgerly" }],
    ["a description past 600 characters", { description: "d".repeat(601), name: "Ledgerly" }],
    ["the unnamed placeholder", { description: UNNAMED_PRODUCT_DESCRIPTION, name: "Ledgerly" }],
  ])("refuses to name a product with %s", (_what, draft) => {
    foundAcme();
    const [first] = store.listProducts();
    expect(() => store.nameProduct(first?.id ?? "", draft)).toThrow(RefusalError);
    expect(store.listProducts()[0]?.name).toBe(first?.name);
  });

  it("refuses to name a product it does not have, or one it retired", () => {
    foundAcme();
    const gadget = store.createProduct({ description: "x", name: "Gadget" });
    store.killProduct(gadget.id, "dud", null);
    const draft = { description: "x", name: "Ledgerly" };
    expect(() => store.nameProduct("nope", draft)).toThrow('No product "nope" here');
    expect(() => store.nameProduct(gadget.id, draft)).toThrow(`${gadget.id} is retired`);
  });

  it("gives a save without a shared folder one at boot", () => {
    const co = foundAcme();
    rmSync(co.workspaceDir, { recursive: true });
    store.initStore();
    expect(store.getCompany()?.workspaceDir).toBe(sharedDir());
    expect(existsSync(co.workspaceDir)).toBe(true);
  });

  it("gives a later product its own workspace and tells every agent about it", () => {
    foundAcme();
    const emp = store.createEmployee(recruit("Quinn"));
    const gadget = store.createProduct({
      description: "A second thing.",
      name: "Gadget",
    });
    expect(gadget.workspaceDir).toBe(productWorkspace(gadget.id));
    expect(existsSync(gadget.workspaceDir)).toBe(true);
    expect(store.employeeInstructions(emp.id)).toContain(gadget.workspaceDir);
    expect(store.attentionProduct()?.id).toBe(store.listProducts()[0]?.id);
  });

  it("attributes a ship to the product the task named, and turns autopilot to the other", () => {
    foundAcme();
    const emp = store.createEmployee(recruit("Ravi"));
    const [first] = store.listProducts();
    const gadget = store.createProduct({ description: "x", name: "Gadget" });
    const task = store.createTask({ origin: "founder", productId: gadget.id, title: "Ship it" });
    finish(task.id, emp.id, "done");
    store.recordShip(task.productId, "shipped");
    expect(store.getProduct(gadget.id)?.ships).toBe(1);
    expect(store.getProduct(first?.id ?? "")?.ships).toBe(0);
    expect(store.getCompany()?.ships).toBe(1);
    expect(store.attentionProduct()?.id).toBe(first?.id);
    expect(store.listShippedTasks()[0]?.productId).toBe(gadget.id);
  });

  it("refuses to bind a product to a Vercel project another product holds", () => {
    foundAcme();
    const [first] = store.listProducts();
    const gadget = store.createProduct({ description: "x", name: "Gadget" });
    const binding = { projectId: "prj_1", projectName: "site", teamId: null };
    store.setProductVercel(first?.id ?? "", binding);
    expect(() => store.setProductVercel(gadget.id, binding)).toThrow(RefusalError);
    expect(store.getProduct(gadget.id)?.vercel).toBeNull();
    expect(store.setProductVercel(first?.id ?? "", binding).vercel).toEqual(binding);
  });
});

describe("a write that fails", () => {
  it("leaves the task as the save has it, free to lock again", () => {
    foundAcme();
    const employee = store.createEmployee(recruit("Priya"));
    const task = store.createTask({ origin: "founder", title: "Ship it" });
    store.claimTask(task.id, employee.id);
    const dir = path.join(tasksDir(), task.id);
    chmodSync(dir, 0o555);
    try {
      expect(() => store.lockTaskForRun(task.id, "run-1")).toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(store.getTask(task.id)?.state.kind).toBe("queued");
    expect(store.lockTaskForRun(task.id, "run-2")?.state).toMatchObject({
      kind: "running",
      runId: "run-2",
    });
  });

  it("still hands a failed run's task back to the queue", () => {
    foundAcme();
    const employee = store.createEmployee(recruit("Priya"));
    const task = store.createTask({ origin: "founder", title: "Ship it" });
    store.claimTask(task.id, employee.id);
    store.lockTaskForRun(task.id, "run-1");
    const dir = path.join(tasksDir(), task.id);
    chmodSync(dir, 0o555);
    try {
      expect(() => store.failTask(task.id, "run-1", "boom")).toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(store.getTask(task.id)).toMatchObject({
      attempts: 1,
      state: { kind: "queued", lastError: "boom" },
    });
  });
});

describe("founding publication", () => {
  it("publishes the complete roster, products, and routines using final workspace paths", () => {
    foundAcme([{ ...hire("Mae"), role: "lead", title: "Team lead" }, hire("Priya")], {
      budget: { capUsd: 0, mode: "capped" },
      businessType: "game-studio",
    });
    const files = saveSnapshot(companyDir());

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
    expect(existsSync(productWorkspace("acme"))).toBe(true);
    expect(files.get("agents/priya/AGENTS.md")).toContain(productWorkspace("acme"));
    expect(readdirSync(root).filter((entry) => entry.startsWith(".founding-"))).toEqual([]);

    expect(store.initStore()).toEqual({ skipped: [] });
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
      const staging = path.join(root, ".founding-interrupted");
      mkdirSync(path.join(staging, "agents", "priya"), { recursive: true });
      writeFileSync(path.join(staging, "agents", "priya", "AGENTS.md"), "partial employee");
      if (hasCompanyFile) {
        writeFileSync(
          path.join(staging, "COMPANY.md"),
          serializeDoc({
            body: "",
            fields: { name: "Acme", slug: "acme" },
            metadata: { createdAt: 1 },
          }),
        );
      }
      const before = saveSnapshot(staging);

      expect(store.initStore()).toEqual({ skipped: [] });
      expect(store.getCompany()).toBeNull();
      expect(existsSync(companyDir())).toBe(false);

      foundAcme([], { budget: { capUsd: 0, mode: "capped" } });

      expect(store.getCompany()?.id).toBe("acme");
      expect(existsSync(companyFile())).toBe(true);
      expect(saveSnapshot(staging)).toEqual(before);
      expect(readdirSync(root).filter((entry) => entry.startsWith(".founding-"))).toEqual([
        ".founding-interrupted",
      ]);
    },
  );
});

describe("the one company a root holds", () => {
  it("refuses to act with no company loaded", () => {
    expect(store.getCompany()).toBeNull();
    expect(store.getEmployee("nobody")).toBeNull();
    expect(store.listQueuedTasks()).toEqual([]);
    expect(() => store.listEmployees()).toThrow("no company is loaded");
    expect(() => store.createTask({ origin: "founder", title: "No" })).toThrow(
      "no company is loaded",
    );
  });

  it("rejects a second founding without touching the save", () => {
    foundAcme();
    const before = saveSnapshot(companyDir());

    expect(() => foundAcme()).toThrow("already active");

    expect(store.getCompany()?.name).toBe("Acme");
    expect(saveSnapshot(companyDir())).toEqual(before);
  });

  it.each(["a COMPANY.md that does not parse", "no COMPANY.md"])(
    "starts no company, and founds none over it, when the save holds %s",
    (failure) => {
      foundAcme([], { budget: { capUsd: 0, mode: "capped" } });
      const employee = store.createEmployee(recruit("Priya"));
      const task = store.createTask({ origin: "founder", title: "Waiting" });
      store.claimTask(task.id, employee.id);
      if (failure === "no COMPANY.md") {
        rmSync(companyFile());
      } else {
        writeFileSync(companyFile(), "corrupt company file");
      }
      const before = saveSnapshot(companyDir());

      const report = store.initStore();

      expect(report.skipped).toEqual([
        expect.objectContaining({ kind: "company", newerBuild: false, path: companyFile() }),
      ]);
      expect(store.getCompany()).toBeNull();
      expect(store.listQueuedTasks()).toEqual([]);
      scheduler.tick();
      expect(() => foundAcme()).toThrow("loaded or repaired");
      expect(saveSnapshot(companyDir())).toEqual(before);
    },
  );

  it("founds beside a save of this build's format moved out of company/", () => {
    foundAcme();
    renameSync(companyDir(), path.join(root, "old-acme"));

    expect(store.initStore()).toEqual({ skipped: [] });
    foundAcme();

    expect(store.getCompany()?.name).toBe("Acme");
    expect(existsSync(path.join(root, "old-acme", "COMPANY.md"))).toBe(true);
  });
});

describe("the digest", () => {
  const inRun = { employeeId: "priya", runId: "r1", taskId: "t1" };

  it("folds what happens after a look, and reading it is the next look", () => {
    foundAcme();
    expect(store.takeDigest()).toBeNull();
    store.logActivity({ ...inRun, createdAt: 1, kind: "ship", message: "v0 shipped" }, true);
    store.logActivity(
      {
        ...inRun,
        createdAt: 2,
        kind: "run.end",
        payload: {
          costUsd: 0.25,
          outcome: { kind: "done" },
          settled: "done",
          summary: "done",
        },
      },
      true,
    );
    store.logActivity(
      {
        createdAt: 3,
        employeeId: "mira",
        kind: "org.hired",
        payload: { by: "lead", name: "Mira", title: "PM" },
      },
      true,
    );
    store.logActivity(
      { ...inRun, createdAt: 4, kind: "task.dead", payload: { attempts: 3, error: "boom" } },
      true,
    );
    store.logActivity({ ...inRun, createdAt: 5, kind: "message", message: "not counted" }, true);

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
    foundAcme();
    store.markSeen(1234);
    store.logActivity({ ...inRun, createdAt: 2000, kind: "ship", message: "while closed" }, true);
    store.initStore();
    expect(store.takeDigest()).toMatchObject({ ships: ["while closed"], since: 1234 });
  });
});

describe("what a run leaves behind", () => {
  it("is kept beside the agent, never in its instructions, and survives a restart", () => {
    const company = foundAcme();
    const emp = store.createEmployee(recruit("Priya"));
    const instructions = path.join(companyDir(), "agents", emp.id, "AGENTS.md");
    const before = readFileSync(instructions, "utf-8");
    store.setRealMetrics({ revenue: 12.5, users: null });

    const session = { id: "session-1", workspace: company.workspaceDir };
    store.noteRunEnd(emp.id, { instructionsDigest: "told-1", session });

    expect(readFileSync(instructions, "utf-8")).toBe(before);
    store.initStore();
    expect(store.getEmployee(emp.id)).toMatchObject({
      instructionsDigest: "told-1",
      lastRunMetrics: { revenueUsd: 12.5, users: null },
      session,
    });
  });

  it("keeps their last ship, for a dialogue to build on without reading the log", () => {
    foundAcme();
    const emp = store.createEmployee(recruit("Priya"));
    const quiet = store.createTask({ origin: "founder", title: "Quiet" });
    finish(quiet.id, emp.id, "");
    expect(store.getEmployee(emp.id)?.lastShip).toBeNull();

    const task = store.createTask({ origin: "founder", title: "Ship it" });
    finish(task.id, emp.id, "x".repeat(600));
    store.initStore();

    expect(store.getEmployee(emp.id)?.lastShip).toEqual({
      summary: "x".repeat(500),
      taskId: task.id,
      title: "Ship it",
    });
  });

  it("ships the work of someone released mid-run", () => {
    foundAcme();
    const emp = store.createEmployee(recruit("Priya"));
    const task = store.createTask({ origin: "founder", title: "Ship it" });
    store.claimTask(task.id, emp.id);
    store.lockTaskForRun(task.id, "run-1");
    store.archiveEmployee(emp.id);

    store.settleTask(task.id, "run-1", { kind: "done", summary: "shipped" });

    expect(store.shippingLog().map((t) => t.id)).toEqual([task.id]);
  });
});

describe("recently shipped", () => {
  it("keeps the latest summaries for the next brief, across a restart", () => {
    foundAcme();
    for (let i = 0; i < 8; i += 1) {
      store.recordShip(null, `ship ${i}`);
    }
    store.markSeen(1);
    expect(readdirSync(path.join(companyDir(), "state")).toSorted()).toEqual([
      "recent-ships.json",
      "since-last-look.json",
    ]);
    store.initStore();
    expect(store.recentShips()).toEqual(Array.from({ length: 6 }, (_, i) => `ship ${i + 2}`));
  });
});

/** Rewrite the task's TASK.md without the `line` it matches, as a hand edit would. */
const dropLine = (taskId: string, line: RegExp): void => {
  const file = path.join(tasksDir(), taskId, "TASK.md");
  writeFileSync(file, readFileSync(file, "utf-8").replace(line, ""));
};

describe("work a hand edit leaves no run or nobody holding", () => {
  it("queues a run whose TASK.md names no lock again, spending no attempt", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const t = store.createTask({ assigneeId: "priya", origin: "founder", title: "Ship it" });
    store.claimTask(t.id, "priya");
    store.lockTaskForRun(t.id, "run-1");
    dropLine(t.id, /\n {2}runId: .*/u);

    store.initStore();

    expect(store.getTask(t.id)).toMatchObject({
      attempts: 0,
      state: { kind: "queued", lastError: "run lock lost", nextAttemptAt: null },
    });
  });

  it.each(["queued", "running"])(
    "gives a %s task nobody holds back as work to pick up",
    (status) => {
      foundAcme([hire("Mae"), hire("Priya")]);
      const t = store.createTask({ assigneeId: "priya", origin: "founder", title: "Ship it" });
      store.claimTask(t.id, "priya");
      if (status === "running") {
        store.lockTaskForRun(t.id, "run-1");
      }
      dropLine(t.id, /\n {2}assigneeId: .*/u);

      store.initStore();

      expect(store.getTask(t.id)).toMatchObject({ assigneeId: null, state: { kind: "todo" } });
    },
  );
});

describe("an answered ask", () => {
  it("is history superseded by its continuation, never a ship", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const ask = store.createTask({ origin: "founder", title: "Ship it" });
    block(ask.id, "priya");

    const next = store.resolveBlockedWithAnswer(ask.id, "yes");

    expect(next).toMatchObject({ assigneeId: "priya", priority: "high" });
    expect(store.getTask(ask.id)).toBeNull();
    expect(existsSync(path.join(shippedDir(), ask.id, "TASK.md"))).toBe(true);
    expect(store.shippingLog()).toEqual([]);
    expect(store.getCompany()?.ships).toBe(0);

    store.initStore();
    expect(store.listShippedTasks()).toMatchObject([
      { id: ask.id, state: { by: next?.id, kind: "superseded" } },
    ]);
    expect(store.listOpenTasks().map((t) => t.id)).toEqual([next?.id]);
  });

  it("drops its continuation once dead when its bet measures, since no retry of it would run", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const bet = launch(firstProduct().id);
    const ask = store.createTask({
      assigneeId: "priya",
      betId: bet.id,
      origin: "work",
      title: "Ask",
    });
    block(ask.id, "priya");
    const next = store.resolveBlockedWithAnswer(ask.id, "yes");
    if (!next) {
      throw new Error("the answer went nowhere");
    }
    writeDead(next.id, "boom");
    store.initStore();

    store.measureBet(bet.id, 0);

    expect(stateOf(next.id)).toEqual({ kind: "dropped", reason: "bet is measuring" });
  });

  it("hands its continuation the reason it existed", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const ask = store.createTask({ origin: "routine", title: "Playtest" });
    block(ask.id, "priya");

    const next = store.resolveBlockedWithAnswer(ask.id, "yes");
    store.initStore();

    expect(next && store.getTask(next.id)?.origin).toBe("routine");
  });

  it("is named on its continuation, so measuring, parking, a restart and a release read no history", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const bet = launch(firstProduct().id);
    const answered = (runId: string): string => {
      const ask = store.createTask({ betId: bet.id, origin: "work", title: "Ask" });
      block(ask.id, "priya");
      const next = store.resolveBlockedWithAnswer(ask.id, "yes");
      if (!next) {
        throw new Error("the answer went nowhere");
      }
      expect(next.answers).toBe(ask.id);
      store.claimTask(next.id, "priya");
      store.lockTaskForRun(next.id, runId);
      return next.id;
    };
    const parking = answered("run-2");
    const cutOff = answered("run-3");
    const unreadable = path.join(shippedDir(), "unreadable", "TASK.md");
    mkdirSync(path.dirname(unreadable), { recursive: true });
    writeFileSync(unreadable, "garbage");
    const historyRead = () => store.loadReport().skipped.some((s) => s.path === unreadable);

    store.measureBet(bet.id, 0);
    expect(store.parkTask(parking, "run-2", 0, "usage limit")).toEqual({ kind: "parked" });
    expect(historyRead()).toBe(false);
    store.initStore();
    expect(store.archiveEmployee("priya")).toMatchObject({ dropped: 0, rehomed: 2 });
    expect(historyRead()).toBe(false);

    expect(store.getTask(parking)).toMatchObject({ assigneeId: "mae", state: { kind: "queued" } });
    expect(store.getTask(cutOff)).toMatchObject({
      assigneeId: "mae",
      state: { kind: "queued", lastError: "Interrupted by app restart" },
    });
    store.listShippedTasks();
    expect(historyRead()).toBe(true);
  });
});

describe("the shipping log as served", () => {
  it("is one line per ship, newest first, with neither its brief nor an answered ask", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1000);
      const first = store.createTask({
        description: "the brief it ran on",
        origin: "founder",
        title: "First",
      });
      finish(first.id, "priya", "one");
      vi.setSystemTime(2000);
      const quiet = store.createTask({ origin: "founder", title: "Quiet" });
      finish(quiet.id, "priya", "");
      const ask = store.createTask({ origin: "founder", title: "Ask" });
      block(ask.id, "mae");
      store.resolveBlockedWithAnswer(ask.id, "yes");
      vi.setSystemTime(3000);
      const second = store.createTask({ origin: "founder", title: "Second" });
      finish(second.id, "mae", "two");
      store.initStore();

      expect(store.shippingLog()).toEqual([
        {
          assigneeId: "mae",
          completedAt: 3000,
          id: second.id,
          productId: null,
          summary: "two",
          title: "Second",
        },
        {
          assigneeId: "priya",
          completedAt: 1000,
          id: first.id,
          productId: null,
          summary: "one",
          title: "First",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("founder approvals", () => {
  it("belong to the task they were given for, once", () => {
    foundAcme();
    store.grantApproval("continue-deploy", "vercel deploy --prod");
    expect(store.holdsApproval("continue-deploy")).toBe(true);
    expect(store.holdsApproval("someone-elses-task")).toBe(false);
    expect(store.consumeApproval("someone-elses-task", "vercel deploy --prod")).toBe(false);
    expect(store.consumeApproval("continue-deploy", "vercel deploy")).toBe(false);
    expect(store.consumeApproval("continue-deploy", "vercel deploy --prod")).toBe(true);
    expect(store.holdsApproval("continue-deploy")).toBe(false);
    expect(store.consumeApproval("continue-deploy", "vercel deploy --prod")).toBe(false);
  });

  it("leave with a task that ended without using them", () => {
    foundAcme();
    store.grantApproval("continue-deploy", "vercel deploy --prod");
    store.revokeApprovals("continue-deploy");
    expect(store.consumeApproval("continue-deploy", "vercel deploy --prod")).toBe(false);
  });

  it("leave with a run a restart ended, as they would had it settled", () => {
    foundAcme();
    const mae = store.createEmployee(recruit("Mae"));
    const t = store.createTask({ assigneeId: mae.id, origin: "founder", title: "Push it" });
    store.claimTask(t.id, mae.id);
    const interrupted = store.lockTaskForRun(t.id, "run-1");
    const waiting = store.createTask({ assigneeId: mae.id, origin: "founder", title: "Deploy" });
    store.claimTask(waiting.id, mae.id);
    if (!interrupted) {
      throw new Error("the run did not lock");
    }
    writeFileSync(
      path.join(tasksDir(), t.id, "TASK.md"),
      serializeDoc(taskToDoc({ ...interrupted, attempts: 4 })),
    );
    store.grantApproval(t.id, "git push origin main");
    store.grantApproval(waiting.id, "vercel deploy --prod");

    store.initStore();
    expect(store.getTask(t.id)?.state.kind).toBe("dead");
    expect(store.holdsApproval(t.id)).toBe(false);
    expect(store.claimTask(t.id, mae.id)?.state.kind).toBe("queued");
    expect(store.consumeApproval(t.id, "git push origin main")).toBe(false);
    expect(store.consumeApproval(waiting.id, "vercel deploy --prod")).toBe(true);
  });
});

describe("the save format", () => {
  it("stamps what it writes", () => {
    foundAcme();
    expect(parseDoc(readFileSync(companyFile(), "utf-8")).metadata.format).toBe(16);
  });

  it("refuses a save a newer build wrote, and leaves it as it found it", () => {
    foundAcme();
    restamp(99);
    const before = saveSnapshot(companyDir());

    const report = store.initStore();

    expect(report.skipped[0]).toMatchObject({ kind: "company", newerBuild: true });
    expect(report.skipped[0]?.error).toContain("newer IdleBiz");
    expect(store.getCompany()).toBeNull();
    expect(saveSnapshot(companyDir())).toEqual(before);
  });

  it.each([
    { stamp: () => restamp(10), stamped: "an older format" },
    {
      stamp: () => {
        writeFileSync(
          companyFile(),
          readFileSync(companyFile(), "utf-8").replace(/\n {2}format: \d+/u, ""),
        );
      },
      stamped: "no format",
    },
  ])("refuses a save stamped with $stamped, and leaves it as it found it", ({ stamp }) => {
    foundAcme();
    stamp();
    const before = saveSnapshot(companyDir());

    const report = store.initStore();

    expect(report.skipped[0]).toMatchObject({ kind: "company", newerBuild: false });
    expect(report.skipped[0]?.error).toContain("pre-release IdleBiz");
    expect(store.getCompany()).toBeNull();
    expect(saveSnapshot(companyDir())).toEqual(before);
  });

  it("leaves alone a package written in a schema it does not read", () => {
    foundAcme();
    const dir = path.join(companyDir(), "routines", "foreign");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "ROUTINE.md"),
      '---\nname: "Foreign"\nschema: "agentcompanies/v9"\nslug: "foreign"\nmetadata:\n  intervalHours: 1\n---\nhi\n',
    );
    const report = store.initStore();
    expect(report.skipped[0]?.error).toContain("agentcompanies/v9");
    expect(store.listRoutines().map((r) => r.id)).not.toContain("foreign");
  });

  it("skips a routine it could not read, and leaves it as the founder wrote it", () => {
    foundAcme([], { businessType: "ecommerce", mission: "sell" });
    const dir = path.join(companyDir(), "routines");
    expect(readdirSync(dir)).toEqual(["store-audit"]);
    const file = path.join(dir, "store-audit", "ROUTINE.md");
    const edited = "---\nbroken: [\n---\nMy own checklist.\n";
    writeFileSync(file, edited);

    const report = store.initStore();
    expect(report.skipped.map((s) => s.kind)).toEqual(["routine"]);
    expect(readFileSync(file, "utf-8")).toBe(edited);
    expect(store.listRoutines()).toEqual([]);
    expect(readdirSync(dir)).toEqual(["store-audit"]);
  });

  it("hands a leaver's dead letter to the lead it elects for a save that names none", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const dead = store.createTask({ assigneeId: "priya", origin: "founder", title: "Side work" });
    writeDead(dead.id, "boom");
    rmSync(employeeAgentDir("priya"), { recursive: true });
    const file = path.join(companyDir(), "COMPANY.md");
    writeFileSync(file, readFileSync(file, "utf-8").replace(/\n {2}leaderId: .*/u, ""));

    store.initStore();
    expect(store.requireCompany().leaderId).toBe("mae");
    expect(store.getTask(dead.id)).toMatchObject({ assigneeId: "mae", state: { kind: "dead" } });
  });

  it("keeps a lead whose AGENTS.md it could not read, who leads again once it reads", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const lead = store.requireCompany().leaderId;
    if (lead === null) {
      throw new Error("founding elected no lead");
    }
    const file = path.join(employeeAgentDir(lead), "AGENTS.md");
    const written = readFileSync(file, "utf-8");
    writeFileSync(file, written.replace(/runner: "?claude"?/u, "runner: clod"));
    const company = readFileSync(companyFile(), "utf-8");

    expect(store.initStore().skipped).toEqual([
      expect.objectContaining({ kind: "employee", path: file }),
    ]);
    expect(store.requireCompany().leaderId).toBe(lead);
    expect(readFileSync(companyFile(), "utf-8")).toBe(company);

    writeFileSync(file, written);
    store.initStore();
    expect(store.requireCompany().leaderId).toBe(lead);
    expect(store.getEmployee(lead)).not.toBeNull();
  });
});
