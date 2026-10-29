import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KILL_GRACE_MS, windowEnd } from "@repo/domain/bets";
import { runPreamble } from "../prompts/briefs";
import * as store from "./store";
import {
  policyFile,
  productsDir,
  retiredDir,
  sharedDir,
  shippedDir,
  tasksDir,
  betFile,
  productWorkspace,
} from "../paths";
import { foundAcme, freshSave, hire } from "../test-support/save";
import { firstProduct, launch, recruit, stateOf, writeDead } from "../test-support/store";

freshSave();

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

  it("keeps a tuned policy across a restart", () => {
    foundAcme();
    mkdirSync(path.dirname(policyFile()), { recursive: true });
    writeFileSync(policyFile(), JSON.stringify({ explore: 0.5 }));
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
