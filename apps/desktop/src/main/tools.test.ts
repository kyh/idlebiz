import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@/shared/activity";
import type { BlockedAsk, TaskOrigin } from "@/shared/domain";
import { BadRequestError } from "@/shared/errors";
import type { RunContext } from "./tools";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-tools-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const store = await import("./store/store");
const { askBox } = await import("./agents/agent-driver");
const { callTool } = await import("./tools");
const { fetchRealMetrics } = await import("./metrics");
const { activityEvents } = await import("./activity");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
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

  it("turns a product or a bet past the portfolio's caps away as an answer, not a fault", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    for (const name of ["Two", "Three", "Four", "Five"]) {
      callTool(ctx, "POST /v1/create-product", { description: name, name });
    }
    expect(callTool(ctx, "POST /v1/create-product", { description: "x", name: "Six" })).toBe(
      "The company already runs 5 products; kill_product one before starting another.",
    );
    for (const title of ["One", "Two", "Three"]) {
      callTool(ctx, "POST /v1/open-bet", { ...BET, product: "acme", title });
    }
    expect(callTool(ctx, "POST /v1/open-bet", { ...BET, product: "acme" })).toBe(
      "Acme already carries 3 live bets; wait for a verdict or kill one first.",
    );
    expect(store.listProducts()).toHaveLength(5);
    expect(store.listBets()).toHaveLength(3);
    expect(logged).not.toHaveBeenCalled();
  });

  it("calls a body that does not parse the caller's error", () => {
    const { ctx } = runAs("mae");
    expect(() => callTool(ctx, "POST /v1/open-bet", { ...BET, target: -1 })).toThrow(
      BadRequestError,
    );
    expect(() => callTool(ctx, "POST /v1/open-bet", { ...BET, target: 1 })).toThrow("at least 10");
    expect(store.listBets()).toEqual([]);
  });

  it("starts no clock over a number nothing could read, and starts it once a source can", () => {
    const { ctx } = runAs("mae");
    const visits = openBet(ctx);
    callTool(ctx, "POST /v1/open-bet", { ...BET, metric: "revenue", title: "Paid tier" });
    const money = store.listBets().find((b) => b.claim.metric === "revenue");
    if (!money) {
      throw new Error("no revenue bet opened");
    }
    const measure = (slug: string) => callTool(ctx, "POST /v1/measure-bet", { slug });

    expect(measure(money.id)).toContain("No source reads revenue yet");
    expect(measure(visits.id)).toContain("No source reads users of");
    expect(store.listBets().map((b) => b.state.kind)).toEqual(["open", "open"]);

    writeFileSync(
      path.join(root, "secrets.json"),
      '{"STRIPE_SECRET_KEY":"sk_live_1","VERCEL_TOKEN":"token"}',
    );
    expect(measure(money.id)).toContain("is measuring");
    expect(measure(visits.id)).toContain("bind Vercel");
    store.setProductVercel(visits.productId, {
      projectId: "prj",
      projectName: "App",
      teamId: null,
    });
    expect(measure(visits.id)).toContain("is measuring");
    expect(measure(visits.id)).toContain("no open bet");
  });

  it("starts no clock on revenue while Stripe is in test mode", () => {
    const { ctx } = runAs("mae");
    callTool(ctx, "POST /v1/open-bet", { ...BET, metric: "revenue", title: "Paid tier" });
    const [money] = store.listBets();
    if (!money) {
      throw new Error("no revenue bet opened");
    }
    const measure = () => callTool(ctx, "POST /v1/measure-bet", { slug: money.id });
    const secrets = path.join(root, "secrets.json");

    writeFileSync(secrets, '{"STRIPE_SECRET_KEY":"sk_test_1"}');
    expect(measure()).toContain("Stripe is in test mode — no charge counts");
    expect(store.getBet(money.id)?.state.kind).toBe("open");

    writeFileSync(secrets, '{"STRIPE_SECRET_KEY":"sk_live_1"}');
    expect(measure()).toContain("is measuring");
  });

  it("kills a revenue bet a test key read as unmeasured, so nothing learns from it", async () => {
    const { ctx } = runAs("mae");
    callTool(ctx, "POST /v1/open-bet", { ...BET, metric: "revenue", title: "Paid tier" });
    const [money] = store.listBets();
    if (!money) {
      throw new Error("no revenue bet opened");
    }
    const testCharge = {
      amount_captured: 700,
      captured: true,
      created: Math.floor(Date.now() / 1000),
      currency: "usd",
      id: "ch_test",
      livemode: false,
      metadata: { bet: money.id },
      paid: true,
    };
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ data: [testCharge], total_count: 1 })),
    );

    const snap = await fetchRealMetrics(
      { key: "sk_test_1", via: "own" },
      store.listProducts(),
      store.listBets(),
    );
    for (const [betId, { reading, at }] of snap.betReadings) {
      store.setBetReading(betId, reading, at);
    }
    callTool(ctx, "POST /v1/kill-bet", { reason: "no live Stripe to count it", slug: money.id });

    expect(store.getBet(money.id)?.state).toMatchObject({ kind: "killed", moved: null });
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

  it("tells the lead which of a released teammate's open work is now theirs, and what was dropped", () => {
    const { ctx } = runAs("mae");
    callTool(ctx, "POST /v1/delegate", HANDOFF);
    const bet = openBet(ctx);
    const ask = store.createTask({
      assigneeId: "priya",
      betId: bet.id,
      origin: "work",
      title: "Ask",
    });
    store.claimTask(ask.id, "priya");
    store.lockTaskForRun(ask.id, "run-1");
    store.settleTask(ask.id, "run-1", {
      ask: { question: "Ship it?", type: "question" },
      kind: "blocked",
      summary: null,
    });
    const answer = callTool(ctx, "POST /v1/release", { slug: "priya" });
    expect(answer).toContain("Their open work is yours now: 1 task,");
    expect(answer).toContain("Dropped 1 task of theirs");
    expect(store.openTasksFor("mae")).toMatchObject([{ id: ask.id }]);
  });

  it("names no inherited work when the teammate left none", () => {
    const { ctx } = runAs("mae");
    const answer = callTool(ctx, "POST /v1/release", { slug: "priya" });
    expect(answer).not.toContain("open work");
    expect(answer).toContain("Released Priya.");
  });

  it("posts a bet the lead opens as the office's news, to the room and the feed alike", () => {
    const { ctx } = runAs("mae");
    const heard: Extract<ActivityEvent, { kind: "chat" }>[] = [];
    const listen = (e: ActivityEvent): void => {
      if (e.kind === "chat") {
        heard.push(e);
      }
    };
    activityEvents.on("activity", listen);
    try {
      openBet(ctx);
      callTool(ctx, "POST /v1/message-team", { text: "on it" });
    } finally {
      activityEvents.off("activity", listen);
    }
    const lines = [
      { from: { kind: "office" }, text: "🎲 New bet: Launch post — a post brings visitors" },
      { from: { id: "mae", kind: "employee" }, text: "on it" },
    ];
    expect(store.recentTeamMessages().map(({ from, text }) => ({ from, text }))).toEqual(lines);
    expect(heard.map((e) => ({ from: e.payload.from, text: e.message }))).toEqual(lines);
    expect(heard.map((e) => e.employeeId)).toEqual([null, "mae"]);
  });
});
