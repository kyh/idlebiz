import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as store from "./store";
import { alumniDir, tasksDir, employeeAgentDir } from "../paths";
import { foundAcme, freshSave, hire } from "../test-support/save";
import { block, firstProduct, launch, stateOf, writeDead } from "../test-support/store";

freshSave();

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
