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
import { KILL_GRACE_MS, windowEnd } from "@repo/domain/bets";
import { UNNAMED_PRODUCT_DESCRIPTION } from "@repo/domain/domain";
import type { Listing } from "../listing";
import { RefusalError } from "../refusal";
import { runPreamble } from "../prompts/briefs";
import { parseDoc, serializeDoc } from "./frontmatter";
import { taskToDoc } from "./task-codec";
import * as store from "./store";
import { createScheduler } from "../scheduler";
import { agentDriver } from "../agents/runner-pool";
import {
  alumniDir,
  companyDir,
  companyFile,
  policyFile,
  productsDir,
  retiredDir,
  sharedDir,
  shippedDir,
  tasksDir,
  betFile,
  employeeAgentDir,
  productWorkspace,
} from "../paths";
import { unaskedIntegrations } from "../test-support/integrations";
import { foundAcme, freshSave, hire } from "../test-support/save";

const root = freshSave();
const asleep = { hold: () => {} };
/** The app's own runner, whose seal no test has checked: its ticks start nothing. */
const scheduler = createScheduler(agentDriver, asleep, unaskedIntegrations);

/** A hire as `createEmployee` takes one, at the first desk. */
const recruit = (name: string) => ({ ...hire(name), deskIndex: 0 });

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

  it.each([
    { metadata: { format: 11 }, stamped: "an older format" },
    { metadata: {}, stamped: "no format" },
  ])(
    "refuses a save from before company/ stamped with $stamped, and founds none beside it",
    ({ metadata }) => {
      const stray = path.join(root, "pocket-ledger");
      mkdirSync(stray, { recursive: true });
      writeFileSync(
        path.join(stray, "COMPANY.md"),
        serializeDoc({
          body: "",
          fields: { name: "Pocket Ledger", slug: "pocket-ledger" },
          metadata,
        }),
      );
      const before = saveSnapshot(stray);

      const report = store.initStore();

      expect(report.skipped).toEqual([
        expect.objectContaining({
          kind: "company",
          newerBuild: false,
          path: path.join(stray, "COMPANY.md"),
        }),
      ]);
      expect(report.skipped[0]?.error).toContain("pre-release IdleBiz");
      expect(store.getCompany()).toBeNull();
      expect(() => foundAcme()).toThrow("loaded or repaired");
      expect(existsSync(companyDir())).toBe(false);
      expect(saveSnapshot(stray)).toEqual(before);
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

const launch = (productId: string, landingPath: string | null = null) =>
  store.openBet({
    budgetUsd: 2,
    hypothesis: "a launch post brings visitors",
    landingPath,
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

/** A task's state, open or shelved as history. */
const stateOf = (id: string) =>
  (store.getTask(id) ?? store.listShippedTasks().find((t) => t.id === id))?.state;

/** Rewrite an open task on disk as dead of `lastError`, as five failed runs or an older build left it; boot reads it. */
const writeDead = (taskId: string, lastError: string): void => {
  const t = store.getTask(taskId);
  if (!t) {
    throw new Error(`no open task ${taskId}`);
  }
  writeFileSync(
    path.join(tasksDir(), taskId, "TASK.md"),
    serializeDoc(taskToDoc({ ...t, state: { kind: "dead", lastError } })),
  );
};

/** Work on a bet in every state a task can be in before it ships: to do, queued, running, waiting on the founder. */
const workOn = (betId: string) => {
  const priya = store.createEmployee(recruit("Priya"));
  const task = (title: string, run: "queue" | "start" | "ask" | null) => {
    const t = store.createTask({ assigneeId: priya.id, betId, origin: "work", title });
    if (run !== null) {
      store.claimTask(t.id, priya.id);
    }
    if (run === "start" || run === "ask") {
      store.lockTaskForRun(t.id, `run-${t.id}`);
    }
    if (run === "ask") {
      store.settleTask(t.id, `run-${t.id}`, {
        ask: { question: "Ship it?", type: "question" },
        kind: "blocked",
        summary: null,
      });
    }
    return t.id;
  };
  const ids = [
    task("Todo", null),
    task("Queued", "queue"),
    task("Running", "start"),
    task("Asked", "ask"),
  ];
  return () => ids.map((id) => stateOf(id)?.kind);
};

/** Run "run-1" on `taskId` ends asking the founder whether to ship. */
const askShipIt = (taskId: string) =>
  store.settleTask(taskId, "run-1", {
    ask: { question: "Ship it?", type: "question" },
    kind: "blocked",
    summary: null,
  });

/** A task on the bet whose run "run-1" is in flight. */
const running = (betId: string, employeeId: string): string => {
  const t = store.createTask({ assigneeId: employeeId, betId, origin: "work", title: "Post it" });
  store.claimTask(t.id, employeeId);
  store.lockTaskForRun(t.id, "run-1");
  return t.id;
};

describe("bets", () => {
  it("gives a users bet a path of its own and refuses one another bet already covers", () => {
    foundAcme();
    const product = firstProduct();
    const bet = launch(product.id);
    expect(bet).toMatchObject({
      claim: { landingPath: `/b/${bet.id}`, metric: "users" },
      reading: null,
      state: { kind: "open" },
    });
    expect(launch(product.id, "/guides").id).not.toBe(bet.id);
    expect(() => launch(product.id, "/guides/late-fees")).toThrow("already counts visitors");
  });

  it("refuses a product a fourth live bet until a verdict frees its room", () => {
    foundAcme();
    const product = firstProduct();
    const [first] = [launch(product.id), launch(product.id), launch(product.id)];
    expect(() => launch(product.id)).toThrow(
      "Acme already carries 3 live bets; wait for a verdict or kill one first.",
    );
    store.killBet(first.id, "dud", 0);
    expect(launch(product.id).state).toEqual({ kind: "open" });
  });

  it.each(["/", "/b", "/b/launch-post"])(
    "refuses a named %s, which counts visitors no new bet brought",
    (landingPath) => {
      foundAcme();
      const product = firstProduct();
      launch(product.id);
      expect(() => launch(product.id, landingPath)).toThrow("did not bring");
    },
  );

  it("keeps a section a closed bet named, since its links still send visitors there", () => {
    foundAcme();
    const product = firstProduct();
    store.killBet(launch(product.id, "/guides").id, "dud", 0);
    expect(() => launch(product.id, "/guides")).toThrow("is closed, but its links still send");
    expect(launch(product.id, "/tools").claim).toEqual({ landingPath: "/tools", metric: "users" });
  });

  it("is judged by what it brought in, and the verdict survives a restart", () => {
    foundAcme();
    const bet = launch(firstProduct().id);
    store.recordBetSpend(bet.id, 2);
    expect(store.judgeBets(0, 0)).toEqual([]);
    expect(store.measureBet(bet.id, 0).state.kind).toBe("measuring");
    store.setBetReading(bet.id, 60, 1);
    store.setBetReading(bet.id, null, 1);
    expect(store.judgeBets(1, 0).map((b) => b.state.kind)).toEqual(["won"]);
    expect(store.judgeBets(2, 0)).toEqual([]);
    expect(existsSync(betFile(bet.id))).toBe(true);
    store.initStore();
    expect(store.getBet(bet.id)).toMatchObject({
      reading: 60,
      spentUsd: 2,
      state: { kind: "won", moved: 60 },
    });
  });

  it("skips and reports a BET.md whose state it cannot read, rather than reopen it", () => {
    foundAcme();
    const bet = launch(firstProduct().id);
    store.killBet(bet.id, "dud", 0);
    const file = betFile(bet.id);
    writeFileSync(file, readFileSync(file, "utf-8").replace(/\n {2}closedAt: .*/u, ""));

    const report = store.initStore();

    expect(report.skipped).toMatchObject([{ kind: "bet", path: file }]);
    expect(store.getBet(bet.id)).toBeNull();
  });

  it("keeps spend its save refused, and the bet's next write carries it", () => {
    foundAcme();
    const bet = launch(firstProduct().id);
    const dir = path.dirname(betFile(bet.id));
    chmodSync(dir, 0o555);
    try {
      expect(() => store.recordBetSpend(bet.id, 1.5)).toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(store.getBet(bet.id)?.spentUsd).toBe(1.5);
    store.setBetReading(bet.id, 10, 1);
    store.initStore();
    expect(store.getBet(bet.id)).toMatchObject({ reading: 10, spentUsd: 1.5 });
  });

  it("keeps a tuned policy's explore, but not a plateau an older build tuned with it", () => {
    foundAcme();
    mkdirSync(path.dirname(policyFile()), { recursive: true });
    writeFileSync(policyFile(), JSON.stringify({ explore: 0.5, plateau: 2 }));
    store.initStore();
    expect(store.allocationPolicy()).toEqual({ explore: 0.5 });
  });

  it("kills a closed window only on a reading taken after it, and stamps a quiet bet once", () => {
    foundAcme();
    const bet = launch(firstProduct().id);
    store.setBetReading(bet.id, 20, 5);
    store.measureBet(bet.id, 0);
    const until = windowEnd(bet, 0);
    store.setBetReading(bet.id, 20, until - 1);
    expect(store.getBet(bet.id)?.readAt).toBe(5);
    expect(store.judgeBets(until + 1, 0)).toEqual([]);
    expect(store.judgeBets(until + KILL_GRACE_MS, null)).toEqual([]);
    store.setBetReading(bet.id, 20, until + 1);
    store.setBetReading(bet.id, 20, until + 2);
    expect(store.getBet(bet.id)?.readAt).toBe(until + 1);
    expect(store.judgeBets(until + 3, null)).toMatchObject([
      { state: { kind: "killed", moved: 20 } },
    ]);
  });

  it("counts a bet's queued and running work as in flight", () => {
    foundAcme();
    const bet = launch(firstProduct().id);
    workOn(bet.id);
    expect(store.runsInFlight()).toEqual(new Map([[bet.id, 2]]));
  });

  it("drops a measuring bet's unstarted work, but keeps what waits on the founder", () => {
    foundAcme();
    const bet = launch(firstProduct().id);
    const states = workOn(bet.id);
    store.measureBet(bet.id, 0);
    expect(states()).toEqual(["dropped", "dropped", "running", "blocked"]);
    expect(store.listShippedTasks().find((t) => t.title === "Queued")?.state).toEqual({
      kind: "dropped",
      reason: "bet is measuring",
    });
  });

  it("drops a killed bet's waiting work, the founder's asks included", () => {
    foundAcme();
    const bet = launch(firstProduct().id);
    const states = workOn(bet.id);
    store.killBet(bet.id, "dud", 0);
    expect(states()).toEqual(["dropped", "dropped", "running", "dropped"]);
  });

  it("shelves dropped work as history the Inbox cannot revive, not as a failure", () => {
    foundAcme();
    const bet = launch(firstProduct().id);
    const priya = store.createEmployee(recruit("Priya"));
    const task = store.createTask({
      assigneeId: priya.id,
      betId: bet.id,
      origin: "work",
      title: "Post it",
    });
    store.killBet(bet.id, "dud", 0);

    expect(store.getTask(task.id)).toBeNull();
    expect(store.claimTask(task.id, priya.id)).toBeNull();
    expect(store.queryTasks({ status: ["blocked", "dead"] })).toEqual([]);
    store.initStore();
    expect(existsSync(path.join(shippedDir(), task.id, "TASK.md"))).toBe(true);
    expect(store.listShippedTasks()).toMatchObject([
      { completedAt: 0, id: task.id, state: { kind: "dropped", reason: "bet killed" } },
    ]);
    expect(store.shippingLog()).toEqual([]);
  });

  it.each([
    {
      event: "measured",
      reason: "bet is measuring",
      stop: (id: string) => store.measureBet(id, 0),
    },
    { event: "killed", reason: "bet killed", stop: (id: string) => store.killBet(id, "dud", 0) },
  ])(
    "drops a dead letter into history once its bet is $event, since no retry could run it",
    ({ stop, reason }) => {
      foundAcme();
      const bet = launch(firstProduct().id);
      const priya = store.createEmployee(recruit("Priya"));
      const task = store.createTask({
        assigneeId: priya.id,
        betId: bet.id,
        origin: "work",
        title: "Post",
      });
      writeDead(task.id, "boom");
      store.initStore();

      stop(bet.id);

      expect(store.queryTasks({ status: ["dead"] })).toEqual([]);
      expect(stateOf(task.id)).toMatchObject({ kind: "dropped", reason });
    },
  );

  it("drops a dead letter into history once its product retired, on a bet or on none", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const bet = launch(side.id);
    const onBet = store.createTask({
      assigneeId: "mae",
      betId: bet.id,
      origin: "work",
      productId: side.id,
      title: "Post",
    });
    const onNone = store.createTask({
      assigneeId: "mae",
      betId: null,
      origin: "founder",
      productId: side.id,
      title: "Ping",
    });
    writeDead(onBet.id, "boom");
    writeDead(onNone.id, "boom");
    store.initStore();
    store.killProduct(side.id, "dud", null);

    expect(store.queryTasks({ status: ["dead"] })).toEqual([]);
    expect(stateOf(onBet.id)).toMatchObject({ kind: "dropped", reason: "product retired" });
    expect(stateOf(onNone.id)).toMatchObject({ kind: "dropped", reason: "product retired" });
  });

  it("drops the retiring run's own work when it fails, parks, asks or is cut off, never queueing it without its product", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const run = (title: string): string => {
      const t = store.createTask({
        assigneeId: "mae",
        betId: null,
        origin: "propose",
        productId: side.id,
        title,
      });
      store.claimTask(t.id, "mae");
      store.lockTaskForRun(t.id, `run-${title}`);
      return t.id;
    };
    const failing = run("fail");
    const parking = run("park");
    const asking = run("ask");
    const cut = run("cut");
    store.killProduct(side.id, "dud", "mae");

    expect(store.failTask(failing, "run-fail", "boom")).toEqual({ kind: "dropped" });
    expect(store.parkTask(parking, "run-park", 0, "usage limit")).toEqual({ kind: "dropped" });
    expect(
      store.settleTask(asking, "run-ask", {
        ask: { question: "Ship it?", type: "question" },
        kind: "blocked",
        summary: null,
      }),
    ).toEqual({ kind: "dropped" });
    store.initStore();
    for (const id of [failing, parking, asking, cut]) {
      expect(stateOf(id)).toEqual({ kind: "dropped", reason: "product retired" });
    }
  });

  it("drops the waiting work of a bet the evaluator closes, and only that bet's", () => {
    foundAcme();
    const product = firstProduct();
    const bet = launch(product.id);
    const other = launch(product.id);
    const states = workOn(bet.id);
    const untouched = store.createTask({ betId: other.id, origin: "work", title: "Elsewhere" });
    store.setBetReading(bet.id, 60, 1);
    expect(store.judgeBets(1, 0).map((b) => b.state.kind)).toEqual(["won"]);
    expect(states()).toEqual(["dropped", "dropped", "running", "dropped"]);
    expect(store.getTask(untouched.id)?.state.kind).toBe("todo");
  });

  it("announces a verdict whose work's save refuses the drop, and never runs that work", () => {
    foundAcme();
    const product = firstProduct();
    const bet = launch(product.id);
    const priya = store.createEmployee(recruit("Priya"));
    const stuck = store.createTask({
      assigneeId: priya.id,
      betId: bet.id,
      origin: "work",
      title: "Post it",
    });
    const dropped = store.createTask({
      assigneeId: priya.id,
      betId: bet.id,
      origin: "work",
      title: "Tweet it",
    });
    store.claimTask(stuck.id, priya.id);
    store.setBetReading(bet.id, 60, 1);
    const dir = path.join(tasksDir(), stuck.id);
    chmodSync(dir, 0o555);
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(store.judgeBets(1, 0).map((b) => b.state.kind)).toEqual(["won"]);
    } finally {
      chmodSync(dir, 0o755);
      vi.restoreAllMocks();
    }
    expect(stateOf(dropped.id)).toEqual({ kind: "dropped", reason: "bet closed" });
    expect(stateOf(stuck.id)?.kind).toBe("queued");
    expect(store.lockTaskForRun(stuck.id, "run-1")).toBeNull();
    expect(stateOf(stuck.id)).toEqual({ kind: "dropped", reason: "bet closed" });
  });

  it("drops a run's task when its bet stops taking work while it runs", () => {
    foundAcme();
    const product = firstProduct();
    const killed = launch(product.id);
    const measured = launch(product.id);
    const priya = store.createEmployee(recruit("Priya"));
    const failing = running(killed.id, priya.id);
    const parking = running(measured.id, priya.id);
    store.killBet(killed.id, "dud", 0);
    store.measureBet(measured.id, 0);

    expect(store.failTask(failing, "run-1", "boom")).toEqual({ kind: "dropped" });
    expect(store.parkTask(parking, "run-1", 0, "usage limit")).toEqual({ kind: "dropped" });
    expect(store.getTask(failing)).toBeNull();
    expect(store.getTask(parking)).toBeNull();
    expect(stateOf(failing)).toEqual({ kind: "dropped", reason: "bet closed" });
    expect(stateOf(parking)).toEqual({ kind: "dropped", reason: "bet is measuring" });
  });

  it("drops a run's ask once its bet has closed, but keeps one on a measuring bet", () => {
    foundAcme();
    const product = firstProduct();
    const killed = launch(product.id);
    const measured = launch(product.id);
    const priya = store.createEmployee(recruit("Priya"));
    const onKilled = running(killed.id, priya.id);
    const onMeasured = running(measured.id, priya.id);
    store.killBet(killed.id, "dud", 0);
    store.measureBet(measured.id, 0);
    expect(askShipIt(onKilled)).toEqual({ kind: "dropped" });
    expect(askShipIt(onMeasured)?.kind).toBe("blocked");
    expect(store.getTask(onKilled)).toBeNull();
    expect(stateOf(onKilled)).toEqual({ kind: "dropped", reason: "bet closed" });
    expect(store.resolveBlockedWithAnswer(onKilled, "yes")).toBeNull();
    expect(store.getTask(onMeasured)?.state.kind).toBe("blocked");
  });

  it("puts a failed or parked run's task back on the queue while its bet is open", () => {
    foundAcme();
    const bet = launch(firstProduct().id);
    const priya = store.createEmployee(recruit("Priya"));
    const failing = running(bet.id, priya.id);
    const parking = running(bet.id, priya.id);

    expect(store.failTask(failing, "run-1", "boom")).toMatchObject({ attempts: 1, kind: "retry" });
    expect(store.parkTask(parking, "run-1", 0, "usage limit")).toEqual({ kind: "parked" });
    expect(store.getTask(failing)?.state).toMatchObject({ kind: "queued", lastError: "boom" });
    expect(store.getTask(parking)?.state).toMatchObject({ kind: "queued", nextAttemptAt: 0 });
  });

  it("drops a run cut off by a restart once its bet stops taking work, and re-queues one on an open bet", () => {
    foundAcme();
    const product = firstProduct();
    const measured = launch(product.id);
    const open = launch(product.id);
    const priya = store.createEmployee(recruit("Priya"));
    const stopped = running(measured.id, priya.id);
    const live = running(open.id, priya.id);
    store.measureBet(measured.id, 0);

    store.initStore();

    expect(store.getTask(stopped)).toBeNull();
    expect(store.listShippedTasks()).toMatchObject([
      { attempts: 0, id: stopped, state: { kind: "dropped", reason: "bet is measuring" } },
    ]);
    expect(store.getTask(live)).toMatchObject({
      attempts: 1,
      state: { kind: "queued", lastError: "Interrupted by app restart" },
    });
  });

  it("keeps the founder's answered step queued when its bet starts measuring, as it keeps an unanswered ask", () => {
    foundAcme();
    const bet = launch(firstProduct().id);
    const priya = store.createEmployee(recruit("Priya"));
    const ask = running(bet.id, priya.id);
    store.settleTask(ask, "run-1", {
      ask: { question: "Ship it?", type: "question" },
      kind: "blocked",
      summary: null,
    });
    const next = store.resolveBlockedWithAnswer(ask, "yes");
    if (!next) {
      throw new Error("the answer went nowhere");
    }
    store.claimTask(next.id, priya.id);

    store.measureBet(bet.id, 0);

    expect(store.getTask(next.id)?.state.kind).toBe("queued");
  });

  it("drops the founder's answered step on a measuring bet when it fails, beyond the Inbox's reach", () => {
    foundAcme();
    const bet = launch(firstProduct().id);
    const priya = store.createEmployee(recruit("Priya"));
    const ask = running(bet.id, priya.id);
    store.settleTask(ask, "run-1", {
      ask: { question: "Ship it?", type: "question" },
      kind: "blocked",
      summary: null,
    });
    store.measureBet(bet.id, 0);
    const next = store.resolveBlockedWithAnswer(ask, "yes");
    if (!next) {
      throw new Error("the answer went nowhere");
    }
    store.claimTask(next.id, priya.id);
    store.lockTaskForRun(next.id, "run-2");

    expect(store.failTask(next.id, "run-2", "boom")?.kind).toBe("dropped");
    expect(store.claimTask(next.id, priya.id)).toBeNull();
  });

  it("re-queues the founder's answered step on a measuring bet when its run parks or is cut off by a restart", () => {
    foundAcme();
    const bet = launch(firstProduct().id);
    const priya = store.createEmployee(recruit("Priya"));
    const answered = (): string => {
      const ask = running(bet.id, priya.id);
      store.settleTask(ask, "run-1", {
        ask: { question: "Ship it?", type: "question" },
        kind: "blocked",
        summary: null,
      });
      const next = store.resolveBlockedWithAnswer(ask, "yes");
      if (!next) {
        throw new Error("the answer went nowhere");
      }
      store.claimTask(next.id, priya.id);
      store.lockTaskForRun(next.id, "run-2");
      return next.id;
    };
    const parking = answered();
    const cutOff = answered();
    store.measureBet(bet.id, 0);

    expect(store.parkTask(parking, "run-2", 0, "usage limit")).toEqual({ kind: "parked" });
    store.initStore();

    expect(store.getTask(parking)?.state).toMatchObject({ kind: "queued", nextAttemptAt: 0 });
    expect(store.getTask(cutOff)?.state).toMatchObject({
      kind: "queued",
      lastError: "Interrupted by app restart",
    });
  });

  it("retires a product with its bets and open work, but never the last one", () => {
    foundAcme();
    const first = firstProduct();
    expect(() => store.killProduct(first.id, "dud", null)).toThrow("only product");
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const bet = launch(side.id);
    const task = store.createTask({
      betId: bet.id,
      origin: "work",
      productId: side.id,
      title: "Post",
    });
    expect(store.killProduct(side.id, "no traction", null).map((b) => b.id)).toEqual([bet.id]);
    expect(store.listProducts().map((p) => p.id)).toEqual([first.id]);
    expect(store.getBet(bet.id)?.state).toMatchObject({ kind: "killed" });
    expect(stateOf(task.id)).toEqual({ kind: "dropped", reason: "product retired" });
    expect(existsSync(path.join(retiredDir(), side.id, "PRODUCT.md"))).toBe(true);
    expect(existsSync(path.join(productsDir(), side.id))).toBe(false);
    store.initStore();
    expect(store.listProducts().map((p) => p.id)).toEqual([first.id]);
  });

  it("refuses a sixth live product, the founder's included, until one is retired", () => {
    foundAcme();
    const second = store.createProduct({ description: "Two", name: "Two" });
    for (const name of ["Three", "Four", "Five"]) {
      store.createProduct({ description: name, name });
    }
    const sixth = { description: "one too many", name: "Six" };
    expect(() => store.createProduct(sixth)).toThrow(
      "The company already runs 5 products; kill_product one before starting another.",
    );
    expect(store.listProducts()).toHaveLength(5);
    store.killProduct(second.id, "no traction", null);
    expect(store.createProduct(sixth).name).toBe("Six");
  });

  it("refuses to retire a product a teammate's run is working in, but not the caller's own", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const bet = launch(side.id);
    const task = store.createTask({
      assigneeId: "priya",
      betId: bet.id,
      origin: "work",
      productId: side.id,
      title: "Post",
    });
    store.claimTask(task.id, "priya");
    store.lockTaskForRun(task.id, "run-1");
    for (const by of [null, "mae"]) {
      expect(() => store.killProduct(side.id, "dud", by)).toThrow("Priya is mid-run on Side");
    }
    expect(store.getBet(bet.id)?.state.kind).toBe("open");
    expect(existsSync(path.join(productsDir(), side.id, "PRODUCT.md"))).toBe(true);
    expect(store.killProduct(side.id, "dud", "priya").map((b) => b.id)).toEqual([bet.id]);
    expect(store.getProduct(side.id)).toBeNull();
  });

  it("retires the first product with its code, as any other; its successor is still pointed at shared/", () => {
    const co = foundAcme();
    const first = firstProduct();
    writeFileSync(path.join(first.workspaceDir, "index.html"), "the old app");
    const next = store.createProduct({ description: "the pivot", name: "Next" });
    store.killProduct(first.id, "no traction", null);
    const archived = path.join(retiredDir(), first.id);
    expect(existsSync(path.join(archived, "PRODUCT.md"))).toBe(true);
    expect(readFileSync(path.join(archived, "workspace", "index.html"), "utf-8")).toBe(
      "the old app",
    );
    expect(existsSync(path.join(productsDir(), first.id))).toBe(false);
    expect(existsSync(co.workspaceDir)).toBe(true);
    store.initStore();
    const company = store.requireCompany();
    expect(store.listProducts().map((p) => p.id)).toEqual([next.id]);
    expect(runPreamble(store.requireProduct(next.id), company)).toContain(sharedDir());
  });

  it("hands a company left with no products a first one with a workspace of its own and nothing shipped", () => {
    foundAcme();
    const first = firstProduct();
    store.recordShip(first.id, "shipped");
    const next = store.createProduct({ description: "the pivot", name: "Next" });
    store.killProduct(first.id, "no traction", null);
    rmSync(path.join(productsDir(), next.id), { recursive: true });
    store.initStore();
    const [only, ...rest] = store.listProducts();
    expect(rest).toEqual([]);
    expect(only?.id).not.toBe(first.id);
    expect(only).toMatchObject({ revenueUsd: null, ships: 0, users: null });
    expect(only?.workspaceDir).toBe(productWorkspace(only?.id ?? ""));
    expect(existsSync(only?.workspaceDir ?? "")).toBe(true);
    expect(store.getCompany()?.ships).toBe(1);
  });

  it("leaves a product boot could not read to the load report, and gives its code to no stand-in", () => {
    foundAcme();
    const first = firstProduct();
    const file = path.join(productsDir(), first.id, "PRODUCT.md");
    const written = readFileSync(file, "utf-8");
    writeFileSync(file, "garbage");

    const report = store.initStore();
    expect(report.skipped.map((s) => s.kind)).toEqual(["product"]);
    expect(store.listProducts()).toEqual([]);
    expect(readdirSync(productsDir())).toEqual([first.id]);

    writeFileSync(file, written);
    store.initStore();
    expect(store.listProducts().map((p) => p.id)).toEqual([first.id]);
  });

  it("still counts a product boot could not read as the company's, so its paid orders are kept", () => {
    foundAcme();
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    writeFileSync(path.join(productsDir(), side.id, "PRODUCT.md"), "garbage");

    store.initStore();

    expect(store.getProduct(side.id)).toBeNull();
    expect(store.madeProduct(side.id)).toBe(true);
    expect(store.madeProduct("elsewhere")).toBe(false);
  });

  it("holds queued work on a product boot could not read, rather than run it in shared/, until the file reads again", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const task = store.createTask({ origin: "founder", productId: side.id, title: "Ship it" });
    store.claimTask(task.id, "priya");
    const file = path.join(productsDir(), side.id, "PRODUCT.md");
    const written = readFileSync(file, "utf-8");
    writeFileSync(file, "garbage");

    store.initStore();
    expect(store.lockTaskForRun(task.id, "run-1")).toBeNull();
    expect(stateOf(task.id)?.kind).toBe("queued");

    writeFileSync(file, written);
    store.initStore();
    expect(store.lockTaskForRun(task.id, "run-1")?.state.kind).toBe("running");
  });
});

const listingOf = (productId: string, id: string): Listing => ({
  betId: null,
  costCents: 1820,
  createdAt: 1,
  id,
  livemode: false,
  name: "Launch tee",
  paymentLink: { id: "plink_1", state: { kind: "selling" }, url: "https://buy.stripe.com/tee" },
  placements: [
    {
      fileUrl: "https://acme.vercel.app/tee.png",
      placement: "front",
      sha256: "a".repeat(64),
      technique: "dtg",
    },
  ],
  priceCents: 2800,
  productId,
  shippingCents: 799,
  variants: [{ id: 4012, label: "Black / S" }],
});

describe("listings", () => {
  it("gives a namesake on any product the next id, and loads each back", () => {
    foundAcme();
    const first = firstProduct();
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const id = store.newListingId("Launch tee");
    store.recordListing(listingOf(first.id, id));
    expect(store.newListingId("Launch tee")).toBe(`${id}-2`);
    store.recordListing(listingOf(side.id, `${id}-2`));
    expect(() => store.recordListing(listingOf(side.id, id))).toThrow("already kept");

    store.initStore();

    expect(store.listListings().map((l) => [l.productId, l.id])).toEqual([
      [first.id, id],
      [side.id, `${id}-2`],
    ]);
  });

  it("holds an id it handed out until the listing is kept or let go, so two listings never share one", () => {
    foundAcme();
    const first = firstProduct();
    const id = store.newListingId("Launch tee");
    expect(store.newListingId("Launch tee")).toBe(`${id}-2`);
    store.releaseListingId(`${id}-2`);
    store.recordListing(listingOf(first.id, id));
    store.releaseListingId(id);

    expect(store.newListingId("Launch tee")).toBe(`${id}-2`);
  });

  it("skips a listing file it cannot read, and keeps a retired product's, whose orders still ship", () => {
    foundAcme();
    firstProduct();
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    store.recordListing(listingOf(side.id, "launch-tee"));
    const broken = path.join(companyDir(), "listings", "broken.json");
    writeFileSync(broken, "{");

    expect(store.initStore().skipped).toMatchObject([{ kind: "listing", path: broken }]);
    store.killProduct(side.id, "dud", null);
    store.initStore();

    expect(store.listListings()).toMatchObject([{ id: "launch-tee", productId: side.id }]);
  });
});

const saleOf = (productId: string, id: string) =>
  ({
    collectedCents: 3599,
    costCents: null,
    createdAt: 2,
    email: null,
    id,
    kind: "sale",
    listingId: "launch-tee",
    livemode: true,
    paymentIntent: null,
    printfulStatus: null,
    productId,
    quantity: 1,
    recipient: {
      address1: "1 Main St",
      address2: null,
      city: "Springfield",
      countryCode: "US",
      name: "Ada Buyer",
      phone: null,
      stateCode: "IL",
      zip: "62701",
    },
    sessionId: `cs_${id}`,
    stage: { kind: "received", tries: 0 },
    variant: { id: 4012, label: "Black / S" },
  }) as const;

describe("orders", () => {
  it("keeps each order of a kept listing across a restart and past its product's retirement", () => {
    foundAcme();
    const first = firstProduct();
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    expect(() => store.recordOrder(saleOf(first.id, "order-a"))).toThrow("no listing");
    store.recordListing(listingOf(first.id, "launch-tee"));
    store.recordListing(listingOf(side.id, "side-tee"));
    store.recordOrder(saleOf(first.id, "order-a"));
    store.recordOrder({ ...saleOf(side.id, "order-b"), listingId: "side-tee" });
    store.updateSale("order-a", { stage: { checks: 0, kind: "pricing", printfulId: 9001 } });
    expect(() => store.recordOrder(saleOf(first.id, "order-a"))).toThrow("already kept");
    const broken = path.join(companyDir(), "orders", "broken.json");
    writeFileSync(broken, "{");

    expect(store.initStore().skipped).toMatchObject([{ kind: "order", path: broken }]);
    expect(store.listOrders()).toMatchObject([
      { id: "order-a", stage: { kind: "pricing", printfulId: 9001 } },
      { id: "order-b" },
    ]);
    store.killProduct(side.id, "dud", null);
    store.updateSale("order-b", { printfulStatus: "pending" });
    store.initStore();
    expect(store.listOrders()).toMatchObject([
      { id: "order-a" },
      { id: "order-b", printfulStatus: "pending" },
    ]);
  });

  it("raises one card per subject, which no teammate can claim and only the founder settles", () => {
    foundAcme();
    const hired = store.createEmployee(recruit("Priya"));
    const ask = { action: "Settle it", draft: null, instructions: "why", type: "action" } as const;
    const subject = { kind: "order", orderId: "order-1", trouble: "trouble" } as const;
    const card = store.raiseOrderCard(subject, "Order 1: trouble", ask);
    expect(store.raiseOrderCard(subject, "Order order-1 is in trouble", ask)).toBeNull();
    expect(card).toMatchObject({ assigneeId: null, origin: "order", productId: null, subject });
    expect(store.claimTask(card?.id ?? "", hired.id)).toBeNull();
    store.initStore();
    expect(store.listOpenTasks()).toMatchObject([
      { origin: "order", state: { ask, kind: "blocked" }, subject },
    ]);
    expect(
      store.raiseOrderCard({ ...subject, trouble: "more" }, "Order 1: trouble", ask),
    ).toMatchObject({ subject: { trouble: "more" } });

    expect(store.closeOrderCard(card?.id ?? "")).toMatchObject({
      state: { kind: "settled" },
      subject,
    });
    expect(store.listOpenTasks()).toHaveLength(1);
    expect(store.raiseOrderCard(subject, "Order 1: trouble", ask)).not.toBeNull();
  });
});

describe("archives", () => {
  it("keep a released employee's slug, so a namesake's release sticks across a restart", () => {
    foundAcme();
    const first = store.createEmployee(recruit("Priya"));
    store.archiveEmployee(first.id);
    const second = store.createEmployee(recruit("Priya"));
    expect(second.id).toBe(`${first.id}-2`);
    store.archiveEmployee(second.id);
    store.initStore();
    expect(store.listEmployees()).toEqual([]);
    expect(existsSync(path.join(alumniDir(), first.id, "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(alumniDir(), second.id, "AGENTS.md"))).toBe(true);
  });

  it("hand a namesake the next number after every one archived", () => {
    foundAcme();
    for (const slug of ["priya", "priya-2"]) {
      const emp = store.createEmployee(recruit("Priya"));
      expect(emp.id).toBe(slug);
      store.archiveEmployee(emp.id);
    }
    expect(store.createEmployee(recruit("Priya")).id).toBe("priya-3");
  });

  it("keep an id past the slug length whole, so no namesake is handed it again", () => {
    foundAcme();
    const name = "A product whose name runs well past the slug length";
    const kept = store.createProduct({ description: "the first", name });
    const retired = store.createProduct({ description: "the second", name });
    expect(retired.id).toBe(`${kept.id}-2`);
    store.killProduct(retired.id, "dud", null);
    expect(existsSync(path.join(retiredDir(), retired.id, "PRODUCT.md"))).toBe(true);
    expect(store.createProduct({ description: "the third", name }).id).toBe(`${kept.id}-3`);
  });

  it("keep a retired product's slug, so a namesake's retirement sticks across a restart", () => {
    foundAcme();
    const first = firstProduct();
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    store.killProduct(side.id, "dud", null);
    const again = store.createProduct({ description: "a second try", name: "Side" });
    expect(again.id).toBe(`${side.id}-2`);
    store.killProduct(again.id, "dud again", null);
    store.initStore();
    expect(store.listProducts().map((p) => p.id)).toEqual([first.id]);
    expect(existsSync(path.join(retiredDir(), side.id, "PRODUCT.md"))).toBe(true);
    expect(existsSync(path.join(retiredDir(), again.id, "PRODUCT.md"))).toBe(true);
  });

  it("archive beside a namesake a save already holds, so the release sticks across a restart", () => {
    foundAcme();
    const first = firstProduct();
    const emp = store.createEmployee(recruit("Priya"));
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const earlier = [path.join(alumniDir(), emp.id), path.join(retiredDir(), side.id)];
    for (const taken of earlier) {
      mkdirSync(taken, { recursive: true });
      writeFileSync(path.join(taken, "README.md"), "someone else's");
    }
    store.archiveEmployee(emp.id);
    store.killProduct(side.id, "dud", null);
    store.initStore();
    expect(store.listEmployees()).toEqual([]);
    expect(store.listProducts().map((p) => p.id)).toEqual([first.id]);
    expect(existsSync(path.join(alumniDir(), `${emp.id}-2`, "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(retiredDir(), `${side.id}-2`, "PRODUCT.md"))).toBe(true);
    for (const taken of earlier) {
      expect(readFileSync(path.join(taken, "README.md"), "utf-8")).toBe("someone else's");
    }
  });

  it("refuse a release or a retirement the move cannot make, and nothing leaves", () => {
    foundAcme();
    const emp = store.createEmployee(recruit("Priya"));
    const task = store.createTask({ assigneeId: emp.id, origin: "founder", title: "Ship it" });
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const bet = launch(side.id);
    for (const archive of [alumniDir(), retiredDir()]) {
      writeFileSync(archive, "not a directory");
    }
    expect(() => store.archiveEmployee(emp.id)).toThrow();
    expect(() => store.killProduct(side.id, "dud", null)).toThrow();
    expect(store.listEmployees().map((e) => e.id)).toEqual([emp.id]);
    expect(store.getTask(task.id)?.assigneeId).toBe(emp.id);
    expect(store.getProduct(side.id)).not.toBeNull();
    expect(store.getBet(bet.id)?.state.kind).toBe("open");
  });
});

const block = (taskId: string, employeeId: string): void => {
  store.claimTask(taskId, employeeId);
  store.lockTaskForRun(taskId, "run-1");
  store.settleTask(taskId, "run-1", {
    ask: { question: "Ship it?", type: "question" },
    kind: "blocked",
    summary: null,
  });
};

describe("a release", () => {
  it("refuses a claim for anyone off the roster", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const task = store.createTask({ origin: "founder", title: "Ship it" });
    store.archiveEmployee("priya");
    expect(store.claimTask(task.id, "ghost")).toBeNull();
    expect(store.claimTask(task.id, "priya")).toBeNull();
    expect(store.getTask(task.id)?.state.kind).toBe("todo");
  });

  it("drops the leaver's unstarted work, holding no bet's run", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const bet = launch(firstProduct().id);
    const queued = store.createTask({
      assigneeId: "priya",
      betId: bet.id,
      origin: "work",
      title: "Post it",
    });
    store.claimTask(queued.id, "priya");
    const todo = store.createTask({
      assigneeId: "priya",
      origin: "founder",
      title: "Answer the founder",
    });

    expect(store.archiveEmployee("priya")).toMatchObject({ dropped: 2, rehomed: 0 });

    expect(store.listQueuedTasks()).toEqual([]);
    expect(store.runsInFlight().get(bet.id)).toBeUndefined();
    store.initStore();
    expect(store.listOpenTasks()).toEqual([]);
    const released = { kind: "dropped", reason: "Priya was released" };
    expect(stateOf(queued.id)).toEqual(released);
    expect(stateOf(todo.id)).toEqual(released);
    expect(store.claimTask(queued.id, "mae")).toBeNull();
  });

  it("hands the leaver's asks and dead letters to the lead, and drops an ask no bet funds", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const bet = launch(firstProduct().id);
    const funded = store.createTask({ betId: bet.id, origin: "work", title: "Post it" });
    block(funded.id, "priya");
    const ping = store.createTask({ origin: "founder", title: "Answer the founder" });
    block(ping.id, "priya");
    const dead = store.createTask({ assigneeId: "priya", origin: "founder", title: "Side work" });
    writeDead(dead.id, "boom");
    store.initStore();

    expect(store.archiveEmployee("priya")).toMatchObject({ dropped: 1, rehomed: 2 });

    expect(store.getTask(funded.id)).toMatchObject({
      assigneeId: "mae",
      state: { kind: "blocked" },
    });
    expect(store.getTask(ping.id)).toBeNull();
    expect(stateOf(ping.id)).toEqual({ kind: "dropped", reason: "Priya was released" });
    expect(store.claimTask(dead.id, "mae")?.state.kind).toBe("queued");
  });
});

describe("a release cut short", () => {
  it("hands on the leaver's work on the next boot", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const bet = launch(firstProduct().id);
    const ask = store.createTask({
      assigneeId: "priya",
      betId: bet.id,
      origin: "work",
      title: "Ask",
    });
    block(ask.id, "priya");
    const side = store.createTask({ assigneeId: "priya", origin: "founder", title: "Side work" });
    mkdirSync(alumniDir(), { recursive: true });
    renameSync(employeeAgentDir("priya"), path.join(alumniDir(), "priya"));

    store.initStore();

    expect(store.getTask(ask.id)).toMatchObject({ assigneeId: "mae", state: { kind: "blocked" } });
    expect(stateOf(side.id)).toEqual({ kind: "dropped", reason: "priya was released" });
  });

  it("hands on the rest when one task's save is refused, and that one on the next boot", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const bet = launch(firstProduct().id);
    const [stuck, rest] = ["First", "Second"].map((title) => {
      const t = store.createTask({ assigneeId: "priya", betId: bet.id, origin: "work", title });
      block(t.id, "priya");
      return t.id;
    });
    if (!stuck || !rest) {
      throw new Error("no asks");
    }
    const dir = path.join(tasksDir(), stuck);
    chmodSync(dir, 0o555);
    try {
      expect(store.archiveEmployee("priya")).toMatchObject({ rehomed: 1 });
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(store.getTask(rest)?.assigneeId).toBe("mae");

    store.initStore();

    expect(store.getTask(stuck)?.assigneeId).toBe("mae");
  });

  it("leaves the work of someone boot could not read on them", () => {
    foundAcme([hire("Mae"), hire("Priya")]);
    const bet = launch(firstProduct().id);
    const ask = store.createTask({
      assigneeId: "priya",
      betId: bet.id,
      origin: "work",
      title: "Ask",
    });
    block(ask.id, "priya");
    writeFileSync(path.join(employeeAgentDir("priya"), "AGENTS.md"), "garbage");

    store.initStore();

    expect(store.getTask(ask.id)?.assigneeId).toBe("priya");
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

  it("seeds no routine over, or beside, the only one it could not read", () => {
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
