import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@/shared/activity";
import type { Employee } from "@/shared/domain";
import { reduceActivity } from "./activity-reducer";

const stamp = { createdAt: 0, id: 1 };

const employee = (id: string): Employee => ({
  companyId: "co",
  createdAt: 0,
  deskIndex: 0,
  id,
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

describe("reduceActivity", () => {
  it("raises an ask in the inbox the moment the office shows it", () => {
    const ask: ActivityEvent = {
      ...stamp,
      employeeId: "priya",
      kind: "run.ask",
      payload: { ask: { question: "Ship it?", type: "question" } },
    };
    expect(reduceActivity(held, ask).reload).toEqual(["tasks"]);
  });

  it("refetches only what an event moved", () => {
    const pulse: ActivityEvent = {
      ...stamp,
      kind: "metrics.pulse",
      payload: { revenue: 1, users: 2 },
    };
    const killed: ActivityEvent = {
      ...stamp,
      kind: "product.killed",
      message: "Side",
      payload: { productId: "side", reason: "dud" },
    };
    expect(reduceActivity(held, pulse).reload).toEqual(["company"]);
    expect(reduceActivity(held, killed).reload).toEqual(["products", "bets"]);
    expect(reduceActivity(held, { ...stamp, kind: "run.start" }).reload).toEqual([]);
  });

  it("patches the one employee a status names, and nobody else", () => {
    const running: ActivityEvent = {
      ...stamp,
      employeeId: "priya",
      kind: "status",
      message: "running",
    };
    const { patch } = reduceActivity(held, running);
    expect(patch.employees?.map((e) => e.status)).toEqual(["working", "idle"]);
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
      createdAt: 0,
      id,
      kind: "run.start" as const,
    }));
    const { patch } = reduceActivity(
      { ...held, activity: full },
      { ...stamp, id: 999, kind: "run.start" },
    );
    expect(patch.activity).toHaveLength(300);
    expect(patch.activity.at(-1)?.id).toBe(999);
    expect(patch.activity[0]?.id).toBe(1);
  });
});
