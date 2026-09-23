import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockedAsk, TaskOrigin } from "@/shared/domain";
import { BadRequestError } from "@/shared/errors";
import type { RunContext } from "./tools";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-tools-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const store = await import("./store/store");
const { askBox } = await import("./agents/agent-driver");
const { callTool } = await import("./tools");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});

afterEach(() => {
  vi.restoreAllMocks();
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
    // the scheduler queues what it is handed, and queued work is in flight
    assign: (taskId, assigneeId) => {
      assigned.push(taskId);
      store.claimTask(taskId, assigneeId);
    },
    company,
    driver: { pickRunner: () => "claude" },
    employee,
    run: { betId: null, origin: "founder", productId: null, runId: "run", taskId: "task" },
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

const openBet = (ctx: RunContext) => {
  callTool(ctx, "POST /v1/open-bet", BET);
  const [bet] = store.listBets();
  if (!bet) {
    throw new Error("no bet opened");
  }
  return bet;
};

const HANDOFF = { description: "write it", role: "engineer", title: "Draft the post" };

describe("company tools", () => {
  it("answers null for a route no tool serves", () => {
    expect(callTool(runAs("mae").ctx, "POST /v1/nope", {})).toBeNull();
  });

  it("turns the lead's tools away from anyone else, before looking at the body", () => {
    const { ctx } = runAs("priya");
    expect(callTool(ctx, "POST /v1/open-bet", {})).toContain("Only the team lead");
    expect(store.listBets()).toEqual([]);
  });

  it("opens a bet for the lead and says how it is counted", () => {
    const { ctx } = runAs("mae");
    const answer = callTool(ctx, "POST /v1/open-bet", BET);
    const [bet] = store.listBets();
    expect(bet?.claim).toEqual({ landingPath: `/b/${bet?.id}`, metric: "users" });
    expect(answer).toContain(`/b/${bet?.id}`);
  });

  it("opens a revenue bet counted by the money tagged with it", () => {
    const { ctx } = runAs("mae");
    const answer = callTool(ctx, "POST /v1/open-bet", { ...BET, metric: "revenue" });
    const [bet] = store.listBets();
    expect(bet?.claim).toEqual({ metric: "revenue" });
    expect(answer).toContain(`metadata[bet]=${bet?.id}`);
  });

  it("answers with the store's refusal rather than failing the call", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    expect(callTool(ctx, "POST /v1/kill-bet", { reason: "dud", slug: "no-such-bet" })).toContain(
      "no live bet",
    );
    expect(logged).not.toHaveBeenCalled();
  });

  it("answers a fault too, so the run goes on, and reports it", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    const fault = new TypeError("cannot read the queue");
    const broken: RunContext = {
      ...ctx,
      assign: () => {
        throw fault;
      },
    };
    expect(callTool(broken, "POST /v1/delegate", HANDOFF)).toBe(fault.message);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[tool /v1/delegate]", fault);
  });

  it("turns a hire away at the seat cap as an answer, not a fault", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    store.setMaxAgents(2);
    expect(callTool(ctx, "POST /v1/hire", { role: "engineer", title: "Engineer" })).toContain(
      "Couldn't hire: the office is at its 2-seat cap",
    );
    expect(store.listEmployees()).toHaveLength(2);
    expect(logged).not.toHaveBeenCalled();
  });

  it("calls a body that does not parse the caller's error", () => {
    const { ctx } = runAs("mae");
    expect(() => callTool(ctx, "POST /v1/open-bet", { ...BET, target: -1 })).toThrow(
      BadRequestError,
    );
  });

  it("refuses a kill reason too long for a line in the room", () => {
    const { ctx } = runAs("mae");
    const bet = openBet(ctx);
    const kill = (reason: string) => callTool(ctx, "POST /v1/kill-bet", { reason, slug: bet.id });
    expect(() => kill("x".repeat(201))).toThrow(BadRequestError);
    expect(store.getBet(bet.id)?.state.kind).toBe("open");
    expect(kill("x".repeat(200))).toContain("Killed");
  });

  it.each([
    { cap: 40, field: "name" },
    { cap: 60, field: "title" },
    { cap: 600, field: "persona" },
  ])("refuses a hire whose $field is too long for every brief", ({ cap, field }) => {
    const { ctx } = runAs("mae");
    const newHire = { name: "Mara", persona: "ships", role: "designer", title: "Designer" };
    const hireWith = (text: string) =>
      callTool(ctx, "POST /v1/hire", { ...newHire, [field]: text });
    expect(() => hireWith("x".repeat(cap + 1))).toThrow(`at ${field}`);
    expect(store.listEmployees()).toHaveLength(2);
    expect(hireWith("x".repeat(cap))).toContain("Hired");
  });

  it("refuses a delegated title too long for the lead's brief", () => {
    const { ctx } = runAs("mae");
    const delegate = (title: string) => callTool(ctx, "POST /v1/delegate", { ...HANDOFF, title });
    expect(() => delegate("x".repeat(81))).toThrow("at title");
    expect(store.listOpenTasks()).toEqual([]);
    expect(delegate("x".repeat(80))).toContain("Delegated");
  });

  it("keeps the first thing a run asks the founder", () => {
    const { ctx, asked } = runAs("priya");
    callTool(ctx, "POST /v1/ask-boss", { question: "Ship it?" });
    callTool(ctx, "POST /v1/request-integration", { kind: "vercel", reason: "to deploy" });
    expect(asked).toEqual([{ question: "Ship it?", type: "question" }]);
    expect(ctx.asks.current()).toEqual({ question: "Ship it?", type: "question" });
  });

  it("delegates to a teammate by role, against the run's bet", () => {
    const { ctx, assigned } = runAs("mae");
    callTool(ctx, "POST /v1/open-bet", BET);
    const [bet] = store.listBets();
    const working = { ...ctx, run: { ...ctx.run, betId: bet?.id ?? null } };
    const answer = callTool(working, "POST /v1/delegate", {
      description: "write it",
      role: "engineer",
      title: "Draft the post",
    });
    expect(answer).toContain("Delegated");
    const [task] = store.listOpenTasks();
    expect(task).toMatchObject({
      assigneeId: "priya",
      betId: bet?.id,
      origin: "delegated",
      productId: bet?.productId,
    });
    expect(assigned).toEqual([task?.id]);
  });

  it("refuses work a bet's runs in flight would already spend", () => {
    const { ctx } = runAs("mae");
    const bet = openBet(ctx);
    store.recordBetSpend(bet.id, 2);
    const named = { ...HANDOFF, bet: bet.id };
    expect(callTool(ctx, "POST /v1/delegate", named)).toContain("Delegated");
    expect(callTool(ctx, "POST /v1/delegate", named)).toContain(
      "no room for another run: $2.00 of $3.00 spent and 1 in flight",
    );
    expect(store.listOpenTasks()).toHaveLength(1);
  });

  it("gives a bet that stopped taking work nothing more, even from its own run", () => {
    const { ctx } = runAs("mae");
    const bet = openBet(ctx);
    const settling = { ...ctx, run: { ...ctx.run, betId: bet.id, productId: bet.productId } };
    store.recordBetSpend(bet.id, 3);
    expect(callTool(settling, "POST /v1/delegate", HANDOFF)).toContain("is spent out");
    store.measureBet(bet.id, 0);
    expect(callTool(settling, "POST /v1/delegate", HANDOFF)).toContain("its clock is running");
    expect(store.listOpenTasks()).toEqual([]);
  });

  it("needs a bet named to put a bet's run to work on another product", () => {
    const { ctx } = runAs("mae");
    const bet = openBet(ctx);
    const side = store.createProduct({ description: "a side project", name: "Side" });
    const working = { ...ctx, run: { ...ctx.run, betId: bet.id } };
    const elsewhere = { ...HANDOFF, product: side.id };
    expect(callTool(working, "POST /v1/delegate", elsewhere)).toContain(`Name a bet on ${side.id}`);
    expect(callTool(ctx, "POST /v1/delegate", elsewhere)).toContain("Delegated");
    expect(store.listOpenTasks()).toMatchObject([{ betId: null, productId: side.id }]);
  });

  it("makes a proposal delegate against the bet it opened, never unfunded", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    const proposing: RunContext = { ...ctx, run: { ...ctx.run, origin: "propose" } };
    expect(callTool(proposing, "POST /v1/delegate", HANDOFF)).toContain("open_bet first");
    expect(logged).not.toHaveBeenCalled();
    expect(store.listOpenTasks()).toEqual([]);
    const bet = openBet(proposing);
    const named = { ...HANDOFF, bet: bet.id };
    expect(callTool(proposing, "POST /v1/delegate", named)).toContain("Delegated");
    expect(store.listOpenTasks()).toMatchObject([{ betId: bet.id, origin: "delegated" }]);
  });

  it.each<TaskOrigin>(["founder", "routine", "delegated"])(
    "lets a %s run delegate work no bet pays for",
    (origin) => {
      const { ctx } = runAs("mae");
      const unfunded: RunContext = { ...ctx, run: { ...ctx.run, origin } };
      expect(callTool(unfunded, "POST /v1/delegate", HANDOFF)).toContain("Delegated");
      expect(store.listOpenTasks()).toMatchObject([{ betId: null, origin: "delegated" }]);
    },
  );

  it("tells the lead how much of a released teammate's open work is now theirs", () => {
    const { ctx } = runAs("mae");
    callTool(ctx, "POST /v1/delegate", HANDOFF);
    store.createTask({ assigneeId: "priya", origin: "founder", title: "Answer the founder" });
    const answer = callTool(ctx, "POST /v1/release", { slug: "priya" });
    expect(answer).toContain("Their open work is yours now: 2 tasks");
    expect(store.openTasksFor("mae")).toHaveLength(2);
  });

  it("names no inherited work when the teammate left none", () => {
    const { ctx } = runAs("mae");
    const answer = callTool(ctx, "POST /v1/release", { slug: "priya" });
    expect(answer).not.toContain("open work");
    expect(answer).toContain("Released Priya.");
  });
});
