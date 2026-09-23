import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@/shared/activity";
import type { Employee } from "@/shared/domain";
import { reduceActivity } from "./activity-reducer";

const stamp = { createdAt: 0, id: 1 };
const inRun = { employeeId: "priya", runId: "r1", taskId: "t1" };

const employee = (id: string): Employee => ({
  companyId: "co",
  createdAt: 0,
  deskIndex: 0,
  id,
  instructionsDigest: null,
  lastRunMetrics: null,
  lastShip: null,
  name: id,
  persona: "",
  role: "engineer",
  runner: "claude",
  sessionId: null,
  spriteSeed: id,
  status: "idle",
  title: "Engineer",
});

const held = { activity: [], employees: [employee("priya"), employee("mae")], resting: {} };
const working: Employee = { ...employee("priya"), status: "working" };
const busy = { ...held, employees: [working] };

describe("reduceActivity", () => {
  it("raises an ask in the inbox the moment the office shows it", () => {
    const ask: ActivityEvent = {
      ...stamp,
      ...inRun,
      kind: "run.ask",
      payload: { ask: { question: "Ship it?", type: "question" } },
    };
    expect(reduceActivity(held, ask).reload).toEqual(["tasks"]);
  });

  it("clears a resolved ask from the inbox the moment it resumes", () => {
    const resumed: ActivityEvent = {
      ...stamp,
      employeeId: "priya",
      kind: "status",
      message: "queued",
      taskId: "t1",
    };
    expect(reduceActivity(held, resumed).reload).toEqual(["tasks"]);
  });

  it("refetches only what an event moved", () => {
    const pulse: ActivityEvent = {
      ...stamp,
      kind: "metrics.pulse",
      payload: { revenue: 1, users: 2 },
    };
    const killed: ActivityEvent = {
      ...stamp,
      employeeId: null,
      kind: "product.killed",
      message: "Side",
      payload: { productId: "side", reason: "dud" },
    };
    expect(reduceActivity(held, pulse).reload).toEqual(["company", "products", "bets"]);
    expect(reduceActivity(held, killed).reload).toEqual(["products", "bets", "tasks"]);
    const said: ActivityEvent = { ...stamp, ...inRun, kind: "message", message: "On it" };
    expect(reduceActivity(held, said).reload).toEqual([]);
  });

  it("fetches again what it patched, for what a refused refresh carried", () => {
    const started: ActivityEvent = { ...stamp, ...inRun, kind: "run.start" };
    const napping: ActivityEvent = {
      ...stamp,
      ...inRun,
      kind: "runner.resting",
      payload: { runner: "claude", until: 5 },
    };
    expect(reduceActivity(held, started).reload).toEqual(["employees"]);
    expect(reduceActivity(held, napping)).toMatchObject({
      patch: { resting: { claude: 5 } },
      reload: ["resting"],
    });
  });

  it("refetches the work a bet dropped when it stopped taking any", () => {
    const measured: ActivityEvent = {
      ...stamp,
      kind: "bet.changed",
      message: "Launch post",
      payload: { betId: "launch-post", state: { kind: "measuring", until: 1 } },
    };
    expect(reduceActivity(held, measured).reload).toEqual(["bets", "tasks"]);
  });

  it("sets to work the one employee a run starts for, and nobody else", () => {
    const started: ActivityEvent = { ...stamp, ...inRun, kind: "run.start" };
    const { patch } = reduceActivity(held, started);
    expect(patch.employees?.map((e) => e.status)).toEqual(["working", "idle"]);
  });

  it("idles an employee whose run ended", () => {
    const ended: ActivityEvent = {
      ...stamp,
      ...inRun,
      kind: "run.end",
      payload: { outcome: { kind: "done" }, summary: "" },
    };
    expect(reduceActivity(busy, ended).patch.employees?.map((e) => e.status)).toEqual(["idle"]);
  });

  it("keeps working someone handed more work mid-run", () => {
    const queued: ActivityEvent = {
      ...stamp,
      employeeId: "priya",
      kind: "status",
      message: "queued",
      taskId: "t2",
    };
    expect(reduceActivity(busy, queued).patch.employees).toBeUndefined();
  });

  it("walks a hire in only after the roster is fresh", () => {
    const hired: ActivityEvent = {
      ...stamp,
      employeeId: "sam",
      kind: "org.hired",
      payload: { by: "mae", name: "Sam", title: "Engineer" },
    };
    expect(reduceActivity(held, hired)).toMatchObject({
      reload: ["all"],
      roster: { employeeId: "sam", hired: true },
    });
  });

  it("keeps the feed to its last three hundred", () => {
    const full = Array.from({ length: 300 }, (_, id) => ({
      ...inRun,
      createdAt: 0,
      id,
      kind: "run.start" as const,
    }));
    const { patch } = reduceActivity(
      { ...held, activity: full },
      { ...stamp, ...inRun, id: 999, kind: "run.start" },
    );
    expect(patch.activity).toHaveLength(300);
    expect(patch.activity.at(-1)?.id).toBe(999);
    expect(patch.activity[0]?.id).toBe(1);
  });
});
