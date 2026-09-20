import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { BlockedAsk } from "@/shared/domain";
import { BadRequestError } from "@/shared/errors";
import type { RunContext } from "./tools";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-tools-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("./store/store");
const { askBox, callTool } = await import("./tools");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env["IDLEBIZ_ROOT_DIR"];
  } else {
    process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
  }
});

const hire = (name: string, title: string) =>
  ({
    name,
    persona: "ships",
    role: "engineer",
    runner: "claude",
    spriteSeed: name,
    title,
  }) as const;

/** A run by `employeeId` in a fresh two-person company led by Mae. */
const runAs = (employeeId: string) => {
  const company = store.foundCompany({
    budget: { mode: "infinite" },
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [hire("Mae", "General Manager"), hire("Priya", "Engineer")],
    mission: "ship",
    name: "Acme",
  });
  const employee = store.getEmployee(employeeId);
  if (!employee) {
    throw new Error(`no ${employeeId}`);
  }
  const asked: BlockedAsk[] = [];
  const assigned: string[] = [];
  const ctx: RunContext = {
    asks: askBox((ask) => asked.push(ask)),
    assign: (taskId) => assigned.push(taskId),
    company,
    driver: {
      disposeEmployee: () => {
        /* nothing to dispose */
      },
      pickRunner: () => "claude",
    },
    employee,
    run: { betId: null, productId: null, runId: "run", taskId: "task" },
  };
  return { asked, assigned, company, ctx };
};

const BET = {
  budgetUsd: 3,
  hypothesis: "a post brings visitors",
  metric: "users",
  target: 50,
  title: "Launch post",
  windowHours: 48,
};

describe("company tools", () => {
  it("answers null for a route no tool serves", () => {
    expect(callTool(runAs("mae").ctx, "POST /v1/nope", {})).toBeNull();
  });

  it("turns the lead's tools away from anyone else, before looking at the body", () => {
    const { ctx, company } = runAs("priya");
    expect(callTool(ctx, "POST /v1/open-bet", {})).toContain("Only the team lead");
    expect(store.listBets(company.id)).toEqual([]);
  });

  it("opens a bet for the lead and says how it is counted", () => {
    const { ctx, company } = runAs("mae");
    const answer = callTool(ctx, "POST /v1/open-bet", BET);
    const [bet] = store.listBets(company.id);
    expect(bet?.claim).toEqual({ landingPath: `/b/${bet?.id}`, metric: "users" });
    expect(answer).toContain(`/b/${bet?.id}`);
  });

  it("answers with the store's refusal rather than failing the call", () => {
    const { ctx } = runAs("mae");
    expect(callTool(ctx, "POST /v1/kill-bet", { reason: "dud", slug: "no-such-bet" })).toContain(
      "no live bet",
    );
  });

  it("calls a body that does not parse the caller's error", () => {
    const { ctx } = runAs("mae");
    expect(() => callTool(ctx, "POST /v1/open-bet", { ...BET, target: -1 })).toThrow(
      BadRequestError,
    );
  });

  it("keeps the first thing a run asks the founder", () => {
    const { ctx, asked } = runAs("priya");
    callTool(ctx, "POST /v1/ask-boss", { question: "Ship it?" });
    callTool(ctx, "POST /v1/request-integration", { kind: "vercel", reason: "to deploy" });
    expect(asked).toEqual([{ question: "Ship it?", type: "question" }]);
    expect(ctx.asks.current()).toEqual({ question: "Ship it?", type: "question" });
  });

  it("delegates to a teammate by role, against the run's bet", () => {
    const { ctx, company, assigned } = runAs("mae");
    callTool(ctx, "POST /v1/open-bet", BET);
    const [bet] = store.listBets(company.id);
    const working = { ...ctx, run: { ...ctx.run, betId: bet?.id ?? null } };
    const answer = callTool(working, "POST /v1/delegate", {
      description: "write it",
      role: "engineer",
      title: "Draft the post",
    });
    expect(answer).toContain("Delegated");
    const [task] = store.listOpenTasks(company.id);
    expect(task).toMatchObject({ assigneeId: "priya", betId: bet?.id, productId: bet?.productId });
    expect(assigned).toEqual([task?.id]);
  });
});
