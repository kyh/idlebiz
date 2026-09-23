import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { zeroUsage } from "@repo/agent-driver/events";
import type { Budget, Task, TaskOrigin } from "@/shared/domain";
import type { RunResult, RunTools } from "./agents/agent-driver";
import type { EmployeeRunner } from "./scheduler";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-scheduler-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("./store/store");
const { companyDir, tasksDir } = await import("./paths");
const { createScheduler, scheduler } = await import("./scheduler");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});

afterAll(() => {
  scheduler.stop();
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env["IDLEBIZ_ROOT_DIR"];
  } else {
    process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
  }
});

const NAMES = ["Priya", "Mae", "Sam", "Ana"];

const UNCAPPED: Budget = { mode: "infinite" };

const found = (budget: Budget = UNCAPPED) =>
  store.foundCompany({
    budget,
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: NAMES.map((name) => ({
      name,
      persona: "ships",
      role: "engineer",
      runner: name === "Ana" ? "codex" : "claude",
      spriteSeed: name,
      title: "Engineer",
    })),
    mission: "ship",
    name: "Acme",
  });

const done = (costUsd = 0): RunResult => ({
  outcome: { kind: "done" },
  session: null,
  summary: "shipped it",
  usage: { ...zeroUsage(), costUsd },
});

const interrupted: RunResult = { ...done(), outcome: { kind: "interrupted" } };

/** A runner whose runs end when the test says so, or as interrupted the moment they are aborted. */
const scripted = () => {
  const running = new Map<string, (result: RunResult) => void>();
  const tools = new Map<string, RunTools>();
  const resting = new Set<string>();
  let started = 0;
  const driver: EmployeeRunner = {
    pickRunner: () => "claude",
    restingRunner: (runner) => (resting.has(runner) ? Date.now() + 60_000 : null),
    runTask: (emp, _company, _task, _onEvent, runTools, signal) =>
      // oxlint-disable-next-line promise/avoid-new -- the test resolves it by hand
      new Promise<RunResult>((resolve) => {
        started += 1;
        running.set(emp.id, resolve);
        tools.set(emp.id, runTools);
        signal.addEventListener("abort", () => resolve(interrupted), { once: true });
      }),
  };
  return { driver, resting, running, started: () => started, tools };
};

const queue = (employeeId: string, priority: Task["priority"] = "medium") => {
  const task = store.createTask({
    assigneeId: employeeId,
    origin: "founder",
    priority,
    title: `Work for ${employeeId}`,
  });
  store.claimTask(task.id, employeeId);
  return task;
};

const kindOf = (task: Task): string | undefined => store.getTask(task.id)?.state.kind;

it("ignores queue drains after stop and resumes admission only after start", () => {
  found({ capUsd: 0, mode: "capped" });
  const task = queue("priya");

  scheduler.stop();
  scheduler.tick();

  expect(store.getCompany()?.autopilot).toBe(true);
  expect(kindOf(task)).toBe("queued");

  scheduler.start();

  expect(store.getCompany()?.autopilot).toBe(false);
  expect(kindOf(task)).toBe("queued");
  expect(store.getEmployee("priya")?.status).toBe("idle");
  scheduler.stop();
});

describe("draining the queue", () => {
  it("keeps a slot back for the founder", () => {
    found();
    const { driver, running } = scripted();
    const drain = createScheduler(driver);
    const background = ["priya", "mae", "sam"].map((id) => queue(id));

    drain.tick();
    drain.tick();

    expect(background.map(kindOf)).toEqual(["running", "running", "queued"]);
    expect(running.size).toBe(2);
  });

  it("gives the reserved slot to the founder's request", () => {
    found();
    const { driver } = scripted();
    const drain = createScheduler(driver);
    queue("priya");
    queue("mae");
    const urgent = queue("ana", "high");
    const waiting = queue("sam");

    drain.tick();

    expect(kindOf(urgent)).toBe("running");
    expect(kindOf(waiting)).toBe("queued");
  });

  it("starts nothing on a runner that is resting", () => {
    found();
    const { driver, resting } = scripted();
    resting.add("codex");
    const parked = queue("ana");
    const free = queue("priya");

    createScheduler(driver).tick();

    expect(kindOf(parked)).toBe("queued");
    expect(kindOf(free)).toBe("running");
  });

  it("moves past a task whose lock cannot write and retries it next tick", () => {
    const company = found();
    const { driver } = scripted();
    const drain = createScheduler(driver);
    const stuck = queue("priya", "high");
    const next = queue("mae");
    const taskDir = path.join(tasksDir(company.id), stuck.id);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    chmodSync(taskDir, 0o555);
    try {
      expect(() => drain.tick()).not.toThrow();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("could not lock task"));
    } finally {
      chmodSync(taskDir, 0o755);
      logged.mockRestore();
    }
    expect(kindOf(stuck)).toBe("queued");
    expect(kindOf(next)).toBe("running");

    drain.tick();

    expect(kindOf(stuck)).toBe("running");
  });
});

const runOne = async (result: RunResult, betId: string | null = null) => {
  const company = found();
  const { driver, running } = scripted();
  const task = store.createTask({
    assigneeId: "priya",
    betId,
    origin: "founder",
    title: "Work",
  });
  store.claimTask(task.id, "priya");
  createScheduler(driver).tick();
  running.get("priya")?.(result);
  await vi.waitFor(() => expect(store.getEmployee("priya")?.status).toBe("idle"));
  return { company, task };
};

describe("settling a run", () => {
  it("ships finished work and frees the employee", async () => {
    const { task } = await runOne(done(0.5));
    expect(store.getTask(task.id)).toBeNull();
    expect(store.getCompany()).toMatchObject({ ships: 1, spentUsd: 0.5 });
  });

  it("bills the run to the bet it worked for", async () => {
    found();
    const [product] = store.listProducts();
    const bet = store.openBet({
      budgetUsd: 5,
      hypothesis: "a post brings visitors",
      landingPath: null,
      metric: "users",
      productId: product?.id ?? "",
      target: 50,
      title: "Launch post",
      windowHours: 24,
    });
    const { driver, running } = scripted();
    const task = store.createTask({
      assigneeId: "priya",
      betId: bet.id,
      origin: "work",
      title: "Post it",
    });
    store.claimTask(task.id, "priya");
    createScheduler(driver).tick();
    running.get("priya")?.(done(1.25));
    await vi.waitFor(() => expect(store.getBet(bet.id)?.spentUsd).toBe(1.25));
  });

  it("books the spend and frees the employee when the settle cannot write", async () => {
    const company = found();
    const { driver, running } = scripted();
    const task = queue("priya");
    createScheduler(driver).tick();
    const taskDir = path.join(tasksDir(company.id), task.id);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    chmodSync(taskDir, 0o555);
    try {
      running.get("priya")?.(done(0.5));
      await vi.waitFor(() => expect(store.getEmployee("priya")?.status).toBe("idle"));
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      chmodSync(taskDir, 0o755);
      logged.mockRestore();
    }
    expect(kindOf(task)).not.toBe("running");
    expect(store.getCompany()?.spentUsd).toBe(0.5);
  });

  it("settles the run and frees the employee when the spend cannot write", async () => {
    const company = found();
    const { driver, running } = scripted();
    const task = queue("priya");
    createScheduler(driver).tick();
    const dir = companyDir(company.id);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    chmodSync(dir, 0o555);
    try {
      running.get("priya")?.(done(0.5));
      await vi.waitFor(() => expect(store.getEmployee("priya")?.status).toBe("idle"));
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("could not book run"));
    } finally {
      chmodSync(dir, 0o755);
      logged.mockRestore();
    }
    expect(kindOf(task)).not.toBe("running");
    expect(store.getCompany()?.spentUsd).toBe(0.5);

    store.setAutopilot(false);
    store.initStore();

    expect(store.getCompany()).toMatchObject({ ships: 1, spentUsd: 0.5 });
  });

  it("holds a task that asked the founder something", async () => {
    const { task } = await runOne({
      ...done(),
      outcome: { ask: { question: "Ship it?", type: "question" }, kind: "blocked" },
    });
    expect(store.getTask(task.id)?.state).toMatchObject({ kind: "blocked" });
  });

  it("queues a failed run to retry, one attempt spent", async () => {
    const { task } = await runOne({ ...done(), outcome: { error: "boom", kind: "failed" } });
    expect(store.getTask(task.id)).toMatchObject({
      attempts: 1,
      state: { kind: "queued", lastError: "boom" },
    });
  });

  it("parks a rate-limited run without spending an attempt", async () => {
    const until = Date.now() + 60_000;
    const { task } = await runOne({
      ...done(),
      outcome: { error: "usage limit", kind: "resting", until },
    });
    expect(store.getTask(task.id)).toMatchObject({
      attempts: 0,
      state: { kind: "queued", nextAttemptAt: until },
    });
  });

  it("requeues runs cut short by a quit, no attempt spent, and starts nothing after them", async () => {
    found();
    const { driver, started } = scripted();
    const drain = createScheduler(driver);
    const cut = [queue("priya"), queue("mae")];
    const waiting = queue("sam");
    drain.tick();
    expect(started()).toBe(2);

    drain.shutdown();

    await vi.waitFor(() => expect(store.getEmployee("mae")?.status).toBe("idle"));
    for (const task of cut) {
      expect(store.getTask(task.id)).toMatchObject({
        attempts: 0,
        state: { kind: "queued", lastError: "Interrupted by app quit" },
      });
    }
    expect(store.getEmployee("priya")?.status).toBe("idle");
    expect(kindOf(waiting)).toBe("queued");
    expect(started()).toBe(2);
  });

  it("takes an unused sign-off away with the task", async () => {
    found();
    const { driver, running } = scripted();
    const task = queue("priya");
    store.grantApproval(task.id, "git push");
    createScheduler(driver).tick();
    running.get("priya")?.(done());
    await vi.waitFor(() => expect(store.getEmployee("priya")?.status).toBe("idle"));
    expect(store.consumeApproval(task.id, "git push")).toBe(false);
  });
});

const openBet = (budgetUsd: number) => {
  const [product] = store.listProducts();
  return store.openBet({
    budgetUsd,
    hypothesis: "a post brings visitors",
    landingPath: null,
    metric: "users",
    productId: product?.id ?? "",
    target: 50,
    title: "Launch post",
    windowHours: 24,
  });
};

/** Leave the lead (Priya, the first hire) waiting on the founder over a task of this origin. */
const blockOnLead = (origin: TaskOrigin) => {
  const task = store.createTask({ assigneeId: "priya", origin, title: "Ask first" });
  store.claimTask(task.id, "priya");
  store.lockTaskForRun(task.id, "run-1");
  store.settleTask(task.id, "run-1", {
    ask: { question: "Which way?", type: "question" },
    kind: "blocked",
    summary: null,
  });
};

const proposing = () =>
  store.openTasksFor("priya").filter((t) => t.origin === "propose" && t.state.kind === "running");

describe("asking the lead for the next bet", () => {
  it.each<TaskOrigin>(["routine", "founder", "delegated"])(
    "goes on while the lead's %s ask waits on the founder",
    (origin) => {
      found();
      blockOnLead(origin);
      const drain = createScheduler(scripted().driver);

      drain.start();
      drain.stop();

      expect(proposing()).toHaveLength(1);
    },
  );

  it("hands the proposal tools that fund nothing but the bet it opens", () => {
    found();
    const { driver, tools } = scripted();
    const drain = createScheduler(driver);

    drain.start();
    drain.stop();

    expect(proposing()).toHaveLength(1);
    const handoff = { description: "write it", role: "engineer", title: "Draft the post" };
    expect(tools.get("priya")?.call("POST /v1/delegate", handoff)).toContain("open_bet first");
  });

  it("waits while the lead's last proposal does", () => {
    found();
    blockOnLead("propose");
    const drain = createScheduler(scripted().driver);

    drain.start();
    drain.stop();

    expect(proposing()).toEqual([]);
  });
});

describe("a release", () => {
  it("frees a spent-out bet for the lead to settle once the leaver's queued work goes", () => {
    found();
    const bet = openBet(1);
    store.recordBetSpend(bet.id, 1);
    const task = store.createTask({
      assigneeId: "mae",
      betId: bet.id,
      origin: "work",
      title: "Post it",
    });
    store.claimTask(task.id, "mae");
    store.archiveEmployee("mae");
    const drain = createScheduler(scripted().driver);

    drain.start();
    drain.stop();

    expect(store.openTasksFor("priya")).toMatchObject([
      { id: task.id, state: { kind: "dead" } },
      { betId: bet.id, state: { kind: "running" } },
    ]);
  });

  it("carries the founder's answer to a leaver's funded ask to the lead", async () => {
    found();
    const bet = openBet(5);
    const { driver, running } = scripted();
    const drain = createScheduler(driver);
    const task = store.createTask({
      assigneeId: "mae",
      betId: bet.id,
      origin: "work",
      title: "Post it",
    });
    drain.assign(task.id, "mae");
    running.get("mae")?.({
      ...done(),
      outcome: { ask: { question: "Ship it?", type: "question" }, kind: "blocked" },
    });
    await vi.waitFor(() => expect(store.getEmployee("mae")?.status).toBe("idle"));
    store.archiveEmployee("mae");

    const continuation = drain.answerQuestion(task.id, "yes");

    expect(continuation.assigneeId).toBe("priya");
    expect(kindOf(continuation)).toBe("running");
  });
});
