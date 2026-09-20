import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { zeroUsage } from "@repo/agent-driver/events";
import type { Budget, Task } from "@/shared/domain";
import type { RunResult } from "./agents/agent-driver";
import type { EmployeeRunner } from "./scheduler";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-scheduler-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("./store/store");
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

/** A runner whose runs end when the test says so. */
const scripted = () => {
  const running = new Map<string, (result: RunResult) => void>();
  const resting = new Set<string>();
  const driver: EmployeeRunner = {
    disposeEmployee: () => {
      /* nothing to dispose */
    },
    pickRunner: () => "claude",
    restingRunner: (runner) => (resting.has(runner) ? Date.now() + 60_000 : null),
    runTask: (emp) =>
      // oxlint-disable-next-line promise/avoid-new -- the test resolves it by hand
      new Promise<RunResult>((resolve) => {
        running.set(emp.id, resolve);
      }),
  };
  return { driver, resting, running };
};

const queue = (employeeId: string, priority: Task["priority"] = "medium") => {
  const task = store.createTask({
    assigneeId: employeeId,
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
});

describe("settling a run", () => {
  const runOne = async (result: RunResult, betId: string | null = null) => {
    const company = found();
    const { driver, running } = scripted();
    const task = store.createTask({
      assigneeId: "priya",
      betId,
      title: "Work",
    });
    store.claimTask(task.id, "priya");
    createScheduler(driver).tick();
    running.get("priya")?.(result);
    await vi.waitFor(() => expect(store.getEmployee("priya")?.status).toBe("idle"));
    return { company, task };
  };

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
      title: "Post it",
    });
    store.claimTask(task.id, "priya");
    createScheduler(driver).tick();
    running.get("priya")?.(done(1.25));
    await vi.waitFor(() => expect(store.getBet(bet.id)?.spentUsd).toBe(1.25));
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
