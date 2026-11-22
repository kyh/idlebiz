import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@repo/domain/activity";
import type { BlockedAsk, Company } from "@repo/domain/domain";
import { alertOf, askLine, noteOf } from "./founder-alerts";

const company = (standingSignOffs: Company["standingSignOffs"]) =>
  ({
    autopilot: true,
    budget: { mode: "infinite" },
    businessType: "software",
    createdAt: 0,
    founderName: "Kai",
    founderSpriteSeed: "s",
    id: "acme",
    leaderId: null,
    maxAgents: 4,
    mission: null,
    name: "Acme",
    revenueUsd: null,
    ships: 0,
    spentUsd: 0,
    standingSignOffs,
    users: null,
    workspaceDir: "/tmp/acme",
  }) satisfies Company;

const nameOf = (id: string) => (id === "priya" ? "Priya" : null);

const deploy = {
  command: "deploy acme to production",
  rule: "deploy",
  type: "approval",
} satisfies BlockedAsk;

const lookup = (standingSignOffs: Company["standingSignOffs"], waiting: BlockedAsk | null) => ({
  company: company(standingSignOffs),
  nameOf,
  waitingOn: (taskId: string) => (taskId === "t1" ? waiting : null),
});

const endedOn = (settled: "blocked" | "done") =>
  ({
    createdAt: 1,
    employeeId: "priya",
    id: 1,
    kind: "run.end",
    payload: { costUsd: 0, outcome: { kind: "done" }, settled, summary: "" },
    runId: "r1",
    taskId: "t1",
  }) satisfies ActivityEvent;

describe("what a closed window tells the founder", () => {
  it("names each kind of ask by what it needs", () => {
    expect(askLine({ question: "Which domain?", type: "question" }, "Priya")).toBe(
      "Priya asks: Which domain?",
    );
    expect(
      askLine(
        { action: "Post the launch thread", draft: null, instructions: "", type: "action" },
        "Priya",
      ),
    ).toBe("Priya needs you to: Post the launch thread");
    expect(
      askLine(
        { integration: "stripe", productId: null, reason: "to charge", type: "integration" },
        "Priya",
      ),
    ).toBe("Priya needs Stripe connected");
    expect(askLine({ command: "deploy acme", rule: "deploy", type: "approval" }, "Priya")).toBe(
      "Sign off: deploy acme",
    );
  });

  it("cuts a long line to one", () => {
    const line = askLine({ question: `Which\n${"x".repeat(200)}`, type: "question" }, "Priya");
    expect(line).toHaveLength(80);
    expect(line).not.toContain("\n");
    expect(line.endsWith("…")).toBe(true);
  });

  it("asks for a sign-off once its run ends on it, unless the founder gave it in advance", () => {
    expect(alertOf(endedOn("blocked"), lookup([], deploy))).toBe(
      "Sign off: deploy acme to production",
    );
    expect(alertOf(endedOn("blocked"), lookup(["payments"], deploy))).toBe(
      "Sign off: deploy acme to production",
    );
    expect(alertOf(endedOn("blocked"), lookup(["deploy"], deploy))).toBeNull();
    expect(alertOf(endedOn("blocked"), lookup([], null))).toBeNull();
    expect(alertOf(endedOn("done"), lookup([], deploy))).toBeNull();
  });

  it("says nothing while the run that asked is still going", () => {
    expect(
      alertOf(
        {
          createdAt: 1,
          employeeId: "priya",
          id: 6,
          kind: "run.ask",
          payload: { ask: deploy },
          runId: "r1",
          taskId: "t1",
        },
        lookup([], deploy),
      ),
    ).toBeNull();
  });

  it("tells of an open order card, a spent budget and a verdict, and nothing routine", () => {
    const card = { createdAt: 1, id: 2, kind: "order.card", message: "Paid orders wait" } as const;
    expect(alertOf({ ...card, payload: { open: true, taskId: "t2" } }, lookup([], null))).toBe(
      "Order card: Paid orders wait",
    );
    expect(
      alertOf({ ...card, payload: { open: false, taskId: "t2" } }, lookup([], null)),
    ).toBeNull();
    expect(
      alertOf(
        {
          createdAt: 1,
          id: 3,
          kind: "budget.exhausted",
          payload: { budget: { capUsd: 5, mode: "capped" }, spentUsd: 5 },
        },
        lookup([], null),
      ),
    ).toMatch(/^Out of budget/u);
    expect(
      alertOf(
        {
          createdAt: 1,
          id: 4,
          kind: "bet.changed",
          message: "Launch post",
          payload: { betId: "b1", state: { closedAt: 1, kind: "won", moved: 3 } },
        },
        lookup([], null),
      ),
    ).toBe("Bet won: Launch post");
    expect(
      alertOf(
        {
          createdAt: 1,
          employeeId: "priya",
          id: 5,
          kind: "status",
          message: "running",
          taskId: "t1",
        },
        lookup([], null),
      ),
    ).toBeNull();
  });

  it("posts a burst as one notification", () => {
    expect(noteOf(["Sign off: deploy acme"])).toEqual({
      body: "Sign off: deploy acme — open IdleBiz to see it.",
      title: "IdleBiz needs you",
    });
    expect(noteOf(["a", "b", "c", "d"])).toEqual({
      body: "a\nb\nc",
      title: "4 things need you in IdleBiz",
    });
  });
});
