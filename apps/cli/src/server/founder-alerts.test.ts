import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@repo/domain/activity";
import type { Company } from "@repo/domain/domain";
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

const deployAsk = {
  createdAt: 1,
  employeeId: "priya",
  id: 1,
  kind: "run.ask",
  payload: { ask: { command: "deploy acme to production", rule: "deploy", type: "approval" } },
  runId: "r1",
  taskId: "t1",
} satisfies ActivityEvent;

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

  it("asks for a sign-off unless the founder gave it in advance", () => {
    expect(alertOf(deployAsk, company([]), nameOf)).toBe("Sign off: deploy acme to production");
    expect(alertOf(deployAsk, company(["payments"]), nameOf)).toBe(
      "Sign off: deploy acme to production",
    );
    expect(alertOf(deployAsk, company(["deploy"]), nameOf)).toBeNull();
  });

  it("tells of an open order card, a spent budget and a verdict, and nothing routine", () => {
    const card = { createdAt: 1, id: 2, kind: "order.card", message: "Paid orders wait" } as const;
    expect(alertOf({ ...card, payload: { open: true, taskId: "t2" } }, company([]), nameOf)).toBe(
      "Order card: Paid orders wait",
    );
    expect(
      alertOf({ ...card, payload: { open: false, taskId: "t2" } }, company([]), nameOf),
    ).toBeNull();
    expect(
      alertOf(
        {
          createdAt: 1,
          id: 3,
          kind: "budget.exhausted",
          payload: { budget: { capUsd: 5, mode: "capped" }, spentUsd: 5 },
        },
        company([]),
        nameOf,
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
        company([]),
        nameOf,
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
        company([]),
        nameOf,
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
