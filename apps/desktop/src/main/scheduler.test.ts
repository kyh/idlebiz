import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { zeroUsage } from "@repo/agent-driver/events";
import type { ActivityEvent } from "@/shared/activity";
import type { Budget, BusinessTypeId, Task, TaskOrigin } from "@/shared/domain";
import { RefusalError } from "@/shared/refusal";
import type { RunResult, RunTools } from "./agents/agent-driver";
import type { EmployeeRunner } from "./scheduler";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-scheduler-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const store = await import("./store/store");
const { betFile, companyDir, routineFile, tasksDir } = await import("./paths");
const { activityEvents } = await import("./activity");
const { createScheduler, scheduler } = await import("./scheduler");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});

afterAll(() => {
  scheduler.stop();
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

const NAMES = ["Priya", "Mae", "Sam", "Ana"];

const UNCAPPED: Budget = { mode: "infinite" };

const found = (budget: Budget = UNCAPPED, businessType: BusinessTypeId = "software") =>
  store.foundCompany({
    budget,
    businessType,
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
  instructionsDigest: null,
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

/** Every run.end published from here on; `stop` unsubscribes. */
const runEnds = () => {
  const ended: ActivityEvent[] = [];
  const listen = (e: ActivityEvent) => {
    if (e.kind === "run.end") {
      ended.push(e);
    }
  };
  activityEvents.on("activity", listen);
  return { ended, stop: () => activityEvents.off("activity", listen) };
};

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

  it("starts the next task when one cannot be locked, and retries it next tick", () => {
    const company = found();
    const drain = createScheduler(scripted().driver);
    const stuck = queue("priya", "high");
    const next = queue("mae");
    const taskDir = path.join(tasksDir(company.id), stuck.id);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    chmodSync(taskDir, 0o555);
    try {
      expect(() => drain.tick()).not.toThrow();
      expect(logged).toHaveBeenCalledWith(`[start task ${stuck.id}]`, expect.anything());
    } finally {
      chmodSync(taskDir, 0o755);
      logged.mockRestore();
    }
    expect(store.getEmployee("priya")?.status).toBe("idle");
    expect(kindOf(stuck)).toBe("queued");
    expect(kindOf(next)).toBe("running");

    drain.tick();

    expect(kindOf(stuck)).toBe("running");
  });

  it("runs every step of the timer's tick past a fault in one", () => {
    found();
    const drain = createScheduler({
      ...scripted().driver,
      restingRunner: () => {
        throw new Error("disk full");
      },
    });
    queue("priya");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => drain.start()).not.toThrow();
      expect(logged).toHaveBeenCalledWith("[drain queue]", expect.anything());
      expect(logged).toHaveBeenCalledWith("[autopilot]", expect.anything());
    } finally {
      drain.stop();
      logged.mockRestore();
    }
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

describe("assigning", () => {
  it("refuses a task that cannot be claimed", () => {
    found();
    const task = queue("priya");
    const drain = createScheduler(scripted().driver);

    expect(() => drain.assign(task.id, "mae")).toThrow(RefusalError);
    expect(store.getTask(task.id)?.assigneeId).toBe("priya");
  });

  it("lets a fault while queuing reach the caller", () => {
    found();
    const { driver } = scripted();
    const drain = createScheduler({
      ...driver,
      restingRunner: () => {
        throw new Error("disk full");
      },
    });

    expect(() => drain.directEmployee("priya", "ship it")).toThrow("disk full");
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
  it("ships finished work, frees the employee and ends the run once", async () => {
    const runs = runEnds();
    const { task } = await runOne(done(0.5));
    runs.stop();
    expect(store.getTask(task.id)).toBeNull();
    expect(store.getCompany()).toMatchObject({ ships: 1, spentUsd: 0.5 });
    expect(runs.ended).toMatchObject([{ payload: { costUsd: 0.5 }, taskId: task.id }]);
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

  it("books the spend, frees the employee and ends the run when the settle cannot write", async () => {
    const company = found();
    const { driver, running } = scripted();
    const task = queue("priya");
    createScheduler(driver).tick();
    const taskDir = path.join(tasksDir(company.id), task.id);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const runs = runEnds();
    chmodSync(taskDir, 0o555);
    try {
      running.get("priya")?.(done(0.5));
      await vi.waitFor(() => expect(store.getEmployee("priya")?.status).toBe("idle"));
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      chmodSync(taskDir, 0o755);
      logged.mockRestore();
      runs.stop();
    }
    expect(kindOf(task)).not.toBe("running");
    expect(store.getCompany()?.spentUsd).toBe(0.5);
    expect(runs.ended).toMatchObject([{ payload: { outcome: { kind: "done" } }, taskId: task.id }]);
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
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("book run"), expect.anything());
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

    await drain.shutdown();

    expect(store.getEmployee("mae")?.status).toBe("idle");
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

  it("waits for an aborted run to settle before it resolves", async () => {
    found();
    const slow: EmployeeRunner = {
      ...scripted().driver,
      runTask: async (_emp, _company, _task, _onEvent, _tools, signal) => {
        await once(signal, "abort");
        await delay(50);
        return interrupted;
      },
    };
    const drain = createScheduler(slow);
    const task = queue("priya");
    drain.tick();

    await drain.shutdown();

    expect(store.getEmployee("priya")?.status).toBe("idle");
    expect(kindOf(task)).toBe("queued");
  });

  it("stops waiting on a run that never settles once the grace is up", async () => {
    found();
    const stuck: EmployeeRunner = {
      ...scripted().driver,
      runTask: () => Promise.withResolvers<RunResult>().promise,
    };
    const drain = createScheduler(stuck);
    const task = queue("priya");
    drain.tick();

    await drain.shutdown(10);

    expect(kindOf(task)).toBe("running");
  });

  it("remembers the session and the instructions it now holds", async () => {
    await runOne({ ...done(), instructionsDigest: "told", session: "session-1" });
    expect(store.getEmployee("priya")).toMatchObject({
      instructionsDigest: "told",
      sessionId: "session-1",
    });
  });

  it("keeps the session and what it was told when the runner throws", async () => {
    found();
    store.noteRunEnd("priya", { instructionsDigest: "told", sessionId: "session-1" });
    const broken: EmployeeRunner = {
      ...scripted().driver,
      runTask: () => Promise.reject(new Error("no CLI")),
    };
    queue("priya");
    createScheduler(broken).tick();
    await vi.waitFor(() => expect(store.getEmployee("priya")?.status).toBe("idle"));
    expect(store.getEmployee("priya")).toMatchObject({
      instructionsDigest: "told",
      sessionId: "session-1",
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

const onProduct = (employeeId: string, productId: string) => {
  const task = store.createTask({
    assigneeId: employeeId,
    origin: "founder",
    productId,
    title: `Work for ${employeeId}`,
  });
  store.claimTask(task.id, employeeId);
  return task;
};

/** The deploy lands in the first product's workspace; the side product has its own. */
const twoProducts = () => {
  found();
  const home = store.listProducts()[0]?.id ?? "";
  const side = store.createProduct({ description: "a side project", name: "Side" }).id;
  const { driver, resting, running } = scripted();
  return { drain: createScheduler(driver), home, resting, running, side };
};

/** Run the employee's work on the product until it asks the founder to deploy it. */
const askToDeploy = async (
  { drain, running }: ReturnType<typeof twoProducts>,
  employeeId: string,
  productId: string,
) => {
  const task = onProduct(employeeId, productId);
  drain.tick();
  running.get(employeeId)?.({
    ...done(),
    outcome: {
      ask: { command: "npx vercel deploy --prod", rule: "deploy", type: "approval" },
      kind: "blocked",
    },
  });
  await vi.waitFor(() => expect(store.getEmployee(employeeId)?.status).toBe("idle"));
  return task;
};

describe("a run the founder signed for", () => {
  it("waits for the run already in its workspace, and nobody new starts there meanwhile", async () => {
    const office = twoProducts();
    const { drain, home, running, side } = office;
    onProduct("mae", home);
    drain.tick();
    const ask = await askToDeploy(office, "priya", home);

    const deploy = drain.resolveApproval(ask.id, true);
    const beside = onProduct("sam", home);
    drain.tick();

    expect(kindOf(deploy)).toBe("queued");
    expect(kindOf(beside)).toBe("queued");

    const elsewhere = onProduct("ana", side);
    drain.tick();

    expect(kindOf(elsewhere)).toBe("running");

    running.get("mae")?.(done());
    await vi.waitFor(() => expect(kindOf(deploy)).toBe("running"));
  });

  it("has its workspace to itself while another product's work goes on", async () => {
    const office = twoProducts();
    const { drain, home, running, side } = office;
    const ask = await askToDeploy(office, "priya", home);

    const deploy = drain.resolveApproval(ask.id, true);
    const beside = onProduct("sam", home);
    drain.tick();

    expect(kindOf(deploy)).toBe("running");
    expect(kindOf(beside)).toBe("queued");

    const elsewhere = onProduct("ana", side);
    drain.tick();

    expect(kindOf(elsewhere)).toBe("running");

    running.get("priya")?.(done());
    await vi.waitFor(() => expect(kindOf(beside)).toBe("running"));
  });

  it("holds nobody back while its own runner rests", async () => {
    const office = twoProducts();
    const { drain, home, resting } = office;
    const ask = await askToDeploy(office, "ana", home);
    resting.add("codex");

    const deploy = drain.resolveApproval(ask.id, true);
    const beside = onProduct("sam", home);
    drain.tick();

    expect(kindOf(deploy)).toBe("queued");
    expect(kindOf(beside)).toBe("running");
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

describe("a file the save refuses on every tick", () => {
  it("judges the other bets and still starts queued work past a verdict that cannot write", () => {
    const company = found();
    const stuck = openBet(5);
    const other = openBet(5);
    for (const bet of [stuck, other]) {
      store.setBetReading(bet.id, 60, Date.now());
    }
    const task = queue("priya");
    const drain = createScheduler(scripted().driver);
    const dir = path.dirname(betFile(company.id, stuck.id));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    chmodSync(dir, 0o555);
    try {
      expect(() => drain.start()).not.toThrow();
      expect(logged).toHaveBeenCalledWith(`[judge bet ${stuck.id}]`, expect.anything());
    } finally {
      drain.stop();
      chmodSync(dir, 0o755);
      logged.mockRestore();
    }
    expect(store.getBet(stuck.id)?.state.kind).toBe("open");
    expect(store.getBet(other.id)?.state.kind).toBe("won");
    expect(kindOf(task)).toBe("running");
  });

  it("still sends idle hands to work past a due routine that cannot be marked run", () => {
    const company = found(UNCAPPED, "game-studio");
    const [routine] = store.listRoutines();
    const drain = createScheduler(scripted().driver);
    const dir = path.dirname(routineFile(company.id, routine?.id ?? ""));
    vi.useFakeTimers({ now: Date.now() + 25 * 3_600_000, toFake: ["Date"] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    chmodSync(dir, 0o555);
    try {
      expect(() => drain.start()).not.toThrow();
      expect(logged).toHaveBeenCalledWith(`[mark routine ${routine?.id}]`, expect.anything());
    } finally {
      drain.stop();
      chmodSync(dir, 0o755);
      logged.mockRestore();
      vi.useRealTimers();
    }
    expect(proposing()).toHaveLength(1);
    expect(store.listOpenTasks().filter((t) => t.origin === "routine")).toEqual([]);
  });
});

describe("a bet that stops taking work mid-run", () => {
  it("drops the task of a run that parks, rather than queue it again, and counts no failure", async () => {
    found();
    const bet = openBet(5);
    const { driver, running } = scripted();
    const task = store.createTask({
      assigneeId: "priya",
      betId: bet.id,
      origin: "work",
      title: "Post it",
    });
    store.claimTask(task.id, "priya");
    createScheduler(driver).tick();
    store.measureBet(bet.id, Date.now());
    const heard: ActivityEvent[] = [];
    const listen = (e: ActivityEvent) => heard.push(e);
    activityEvents.on("activity", listen);
    try {
      running.get("priya")?.({
        ...done(),
        outcome: { error: "usage limit", kind: "resting", until: Date.now() + 60_000 },
      });
      await vi.waitFor(() => expect(store.getEmployee("priya")?.status).toBe("idle"));
    } finally {
      activityEvents.off("activity", listen);
    }

    expect(store.getTask(task.id)).toBeNull();
    expect(store.listShippedTasks()).toMatchObject([
      { id: task.id, state: { kind: "dropped", reason: "bet is measuring" } },
    ]);
    expect(heard.filter((e) => e.kind === "task.dead")).toEqual([]);
    expect(heard.find((e) => e.kind === "status")).toMatchObject({ message: "dropped" });
  });

  it("names none of the work a killed bet dropped among the failures in the lead's next brief", () => {
    found();
    const bet = openBet(5);
    store.createTask({ assigneeId: "mae", betId: bet.id, origin: "work", title: "Post it" });
    store.killBet(bet.id, "dud", Date.now());
    const drain = createScheduler(scripted().driver);

    drain.start();
    drain.stop();

    expect(proposing()[0]?.description).toContain("fixing or unblocking:\n(none)");
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
      { betId: bet.id, origin: "settle", state: { kind: "running" } },
    ]);
    expect(store.listShippedTasks()).toMatchObject([
      { id: task.id, state: { kind: "dropped", reason: "Mae was released" } },
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
