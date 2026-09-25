import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@/shared/activity";
import type { BlockedAsk, TaskOrigin } from "@/shared/domain";
import { BadRequestError } from "@/shared/errors";
import type { DeployRequest, DeployResult } from "./deploy";
import type { RunContext } from "./tools";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-tools-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const store = await import("./store/store");
const { askBox } = await import("./agents/agent-driver");
const { callTool } = await import("./tools");
const { stripePaymentLink } = await import("./payment-links");
const { pusherOver } = await import("./git-push");
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
    createPaymentLink: () => Promise.reject(new Error("charged without a test asking for it")),
    deploy: () => Promise.reject(new Error("deployed without a test asking for it")),
    driver: { pickRunner: () => "claude" },
    employee,
    push: () => Promise.reject(new Error("pushed without a test asking for it")),
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

const openBet = async (ctx: RunContext) => {
  await callTool(ctx, "POST /v1/open-bet", BET);
  const [bet] = store.listBets();
  if (!bet) {
    throw new Error("no bet opened");
  }
  return bet;
};

const HANDOFF = { description: "write it", role: "engineer", title: "Draft the post" };

describe("company tools", () => {
  it("answers null for a route no tool serves", async () => {
    expect(await callTool(runAs("mae").ctx, "POST /v1/nope", {})).toBeNull();
  });

  it("turns the lead's tools away from anyone else, before looking at the body", async () => {
    const { ctx } = runAs("priya");
    expect(await callTool(ctx, "POST /v1/open-bet", {})).toContain("Only the team lead");
    expect(store.listBets()).toEqual([]);
  });

  it("opens a bet for the lead and says how it is counted", async () => {
    const { ctx } = runAs("mae");
    const answer = await callTool(ctx, "POST /v1/open-bet", BET);
    const [bet] = store.listBets();
    expect(bet?.claim).toEqual({ landingPath: `/b/${bet?.id}`, metric: "users" });
    expect(answer).toContain(`/b/${bet?.id}`);
  });

  it("opens a revenue bet counted by the money tagged with it", async () => {
    const { ctx } = runAs("mae");
    const answer = await callTool(ctx, "POST /v1/open-bet", { ...BET, metric: "revenue" });
    const [bet] = store.listBets();
    expect(bet?.claim).toEqual({ metric: "revenue" });
    expect(answer).toContain(`metadata[bet]=${bet?.id}`);
  });

  it("answers with the store's refusal rather than failing the call", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    expect(
      await callTool(ctx, "POST /v1/kill-bet", { reason: "dud", slug: "no-such-bet" }),
    ).toContain("no live bet");
    expect(logged).not.toHaveBeenCalled();
  });

  it("answers a fault too, so the run goes on, and reports it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    const fault = new TypeError("cannot read the queue");
    const broken: RunContext = {
      ...ctx,
      assign: () => {
        throw fault;
      },
    };
    expect(await callTool(broken, "POST /v1/delegate", HANDOFF)).toBe(fault.message);
    expect(logged).toHaveBeenCalledExactlyOnceWith("[tool /v1/delegate]", fault);
  });

  it("turns a hire away at the seat cap as an answer, not a fault", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    store.setMaxAgents(2);
    expect(await callTool(ctx, "POST /v1/hire", { role: "engineer", title: "Engineer" })).toContain(
      "Couldn't hire: the office is at its 2-seat cap",
    );
    expect(store.listEmployees()).toHaveLength(2);
    expect(logged).not.toHaveBeenCalled();
  });

  it("turns a product or a bet past the portfolio's caps away as an answer, not a fault", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    for (const name of ["Two", "Three", "Four", "Five"]) {
      await callTool(ctx, "POST /v1/create-product", { description: name, name });
    }
    expect(await callTool(ctx, "POST /v1/create-product", { description: "x", name: "Six" })).toBe(
      "The company already runs 5 products; kill_product one before starting another.",
    );
    for (const title of ["One", "Two", "Three"]) {
      await callTool(ctx, "POST /v1/open-bet", { ...BET, product: "acme", title });
    }
    expect(await callTool(ctx, "POST /v1/open-bet", { ...BET, product: "acme" })).toBe(
      "Acme already carries 3 live bets; wait for a verdict or kill one first.",
    );
    expect(store.listProducts()).toHaveLength(5);
    expect(store.listBets()).toHaveLength(3);
    expect(logged).not.toHaveBeenCalled();
  });

  it("calls a body that does not parse the caller's error", async () => {
    const { ctx } = runAs("mae");
    await expect(callTool(ctx, "POST /v1/open-bet", { ...BET, target: -1 })).rejects.toThrow(
      BadRequestError,
    );
    await expect(callTool(ctx, "POST /v1/open-bet", { ...BET, target: 1 })).rejects.toThrow(
      "at least 10",
    );
    expect(store.listBets()).toEqual([]);
  });

  it("starts no clock over a number nothing could read, and starts it once a source can", async () => {
    const { ctx } = runAs("mae");
    const visits = await openBet(ctx);
    await callTool(ctx, "POST /v1/open-bet", { ...BET, metric: "revenue", title: "Paid tier" });
    const money = store.listBets().find((b) => b.claim.metric === "revenue");
    if (!money) {
      throw new Error("no revenue bet opened");
    }
    const measure = (slug: string) => callTool(ctx, "POST /v1/measure-bet", { slug });

    expect(await measure(money.id)).toBe(
      'No source reads revenue yet — request_integration "stripe": its card takes the founder to the Budget panel to connect Stripe or add a Stripe key. Then measure_bet again.',
    );
    expect(await measure(visits.id)).toContain("No source reads users of");
    expect(store.listBets().map((b) => b.state.kind)).toEqual(["open", "open"]);

    writeFileSync(
      path.join(root, "secrets.json"),
      '{"STRIPE_SECRET_KEY":"sk_live_1","VERCEL_TOKEN":"token"}',
    );
    expect(await measure(money.id)).toContain("is measuring");
    expect(await measure(visits.id)).toContain("bind Vercel");
    store.setProductVercel(visits.productId, {
      projectId: "prj",
      projectName: "App",
      teamId: null,
    });
    expect(await measure(visits.id)).toContain("is measuring");
    expect(await measure(visits.id)).toContain("no open bet");
  });

  it("starts no clock on revenue while Stripe is in test mode", async () => {
    const { ctx } = runAs("mae");
    await callTool(ctx, "POST /v1/open-bet", { ...BET, metric: "revenue", title: "Paid tier" });
    const [money] = store.listBets();
    if (!money) {
      throw new Error("no revenue bet opened");
    }
    const measure = () => callTool(ctx, "POST /v1/measure-bet", { slug: money.id });
    const secrets = path.join(root, "secrets.json");

    writeFileSync(secrets, '{"STRIPE_SECRET_KEY":"sk_test_1"}');
    expect(await measure()).toContain("Stripe is in test mode — no charge counts");
    expect(store.getBet(money.id)?.state.kind).toBe("open");

    writeFileSync(secrets, '{"STRIPE_SECRET_KEY":"sk_live_1"}');
    expect(await measure()).toContain("is measuring");
  });

  it("kills a revenue bet a test key read as unmeasured, so nothing learns from it", async () => {
    const { ctx } = runAs("mae");
    await callTool(ctx, "POST /v1/open-bet", { ...BET, metric: "revenue", title: "Paid tier" });
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
    await callTool(ctx, "POST /v1/kill-bet", {
      reason: "no live Stripe to count it",
      slug: money.id,
    });

    expect(store.getBet(money.id)?.state).toMatchObject({ kind: "killed", moved: null });
  });

  it("refuses a kill reason too long for a line in the room", async () => {
    const { ctx } = runAs("mae");
    const bet = await openBet(ctx);
    const kill = (reason: string) => callTool(ctx, "POST /v1/kill-bet", { reason, slug: bet.id });
    await expect(kill("x".repeat(201))).rejects.toThrow(BadRequestError);
    expect(store.getBet(bet.id)?.state.kind).toBe("open");
    expect(await kill("x".repeat(200))).toContain("Killed");
  });

  it.each([
    { cap: 40, field: "name" },
    { cap: 60, field: "title" },
    { cap: 600, field: "persona" },
  ])("refuses a hire whose $field is too long for every brief", async ({ cap, field }) => {
    const { ctx } = runAs("mae");
    const newHire = { name: "Mara", persona: "ships", role: "designer", title: "Designer" };
    const hireWith = (text: string) =>
      callTool(ctx, "POST /v1/hire", { ...newHire, [field]: text });
    await expect(hireWith("x".repeat(cap + 1))).rejects.toThrow(`at ${field}`);
    expect(store.listEmployees()).toHaveLength(2);
    expect(await hireWith("x".repeat(cap))).toContain("Hired");
  });

  it("refuses a delegated title too long for the lead's brief", async () => {
    const { ctx } = runAs("mae");
    const delegate = (title: string) => callTool(ctx, "POST /v1/delegate", { ...HANDOFF, title });
    await expect(delegate("x".repeat(81))).rejects.toThrow("at title");
    expect(store.listOpenTasks()).toEqual([]);
    expect(await delegate("x".repeat(80))).toContain("Delegated");
  });

  it("keeps the first thing a run asks the founder", async () => {
    const { ctx, asked } = runAs("priya");
    await callTool(ctx, "POST /v1/ask-boss", { question: "Ship it?" });
    await callTool(ctx, "POST /v1/request-integration", { kind: "vercel", reason: "to deploy" });
    expect(asked).toEqual([{ question: "Ship it?", type: "question" }]);
    expect(ctx.asks.current()).toEqual({ question: "Ship it?", type: "question" });
  });

  it("delegates to a teammate by role, against the run's bet", async () => {
    const { ctx, assigned } = runAs("mae");
    await callTool(ctx, "POST /v1/open-bet", BET);
    const [bet] = store.listBets();
    const working = { ...ctx, run: { ...ctx.run, betId: bet?.id ?? null } };
    const answer = await callTool(working, "POST /v1/delegate", {
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

  it("refuses work a bet's runs in flight would already spend", async () => {
    const { ctx } = runAs("mae");
    const bet = await openBet(ctx);
    store.recordBetSpend(bet.id, 2);
    const named = { ...HANDOFF, bet: bet.id };
    expect(await callTool(ctx, "POST /v1/delegate", named)).toContain("Delegated");
    expect(await callTool(ctx, "POST /v1/delegate", named)).toContain(
      "no room for another run: $2.00 of $3.00 spent and 1 in flight",
    );
    expect(store.listOpenTasks()).toHaveLength(1);
  });

  it("gives a bet that stopped taking work nothing more, even from its own run", async () => {
    const { ctx } = runAs("mae");
    const bet = await openBet(ctx);
    const settling = { ...ctx, run: { ...ctx.run, betId: bet.id, productId: bet.productId } };
    store.recordBetSpend(bet.id, 3);
    expect(await callTool(settling, "POST /v1/delegate", HANDOFF)).toContain("is spent out");
    store.measureBet(bet.id, 0);
    expect(await callTool(settling, "POST /v1/delegate", HANDOFF)).toContain(
      "its clock is running",
    );
    expect(store.listOpenTasks()).toEqual([]);
  });

  it("needs a bet named to put a bet's run to work on another product", async () => {
    const { ctx } = runAs("mae");
    const bet = await openBet(ctx);
    const side = store.createProduct({ description: "a side project", name: "Side" });
    const working = { ...ctx, run: { ...ctx.run, betId: bet.id } };
    const elsewhere = { ...HANDOFF, product: side.id };
    expect(await callTool(working, "POST /v1/delegate", elsewhere)).toContain(
      `Name a bet on ${side.id}`,
    );
    expect(await callTool(ctx, "POST /v1/delegate", elsewhere)).toContain("Delegated");
    expect(store.listOpenTasks()).toMatchObject([{ betId: null, productId: side.id }]);
  });

  it("makes a proposal delegate against the bet it opened, never unfunded", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    const proposing: RunContext = { ...ctx, run: { ...ctx.run, origin: "propose" } };
    expect(await callTool(proposing, "POST /v1/delegate", HANDOFF)).toContain("open_bet first");
    expect(logged).not.toHaveBeenCalled();
    expect(store.listOpenTasks()).toEqual([]);
    const bet = await openBet(proposing);
    const named = { ...HANDOFF, bet: bet.id };
    expect(await callTool(proposing, "POST /v1/delegate", named)).toContain("Delegated");
    expect(store.listOpenTasks()).toMatchObject([{ betId: bet.id, origin: "delegated" }]);
  });

  it.each<TaskOrigin>(["founder", "routine", "delegated"])(
    "lets a %s run delegate work no bet pays for",
    async (origin) => {
      const { ctx } = runAs("mae");
      const unfunded: RunContext = { ...ctx, run: { ...ctx.run, origin } };
      expect(await callTool(unfunded, "POST /v1/delegate", HANDOFF)).toContain("Delegated");
      expect(store.listOpenTasks()).toMatchObject([{ betId: null, origin: "delegated" }]);
    },
  );

  it("tells the lead which of a released teammate's open work is now theirs, and what was dropped", async () => {
    const { ctx } = runAs("mae");
    await callTool(ctx, "POST /v1/delegate", HANDOFF);
    const bet = await openBet(ctx);
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
    const answer = await callTool(ctx, "POST /v1/release", { slug: "priya" });
    expect(answer).toContain("Their open work is yours now: 1 task,");
    expect(answer).toContain("Dropped 1 task of theirs");
    expect(store.openTasksFor("mae")).toMatchObject([{ id: ask.id }]);
  });

  it("names no inherited work when the teammate left none", async () => {
    const { ctx } = runAs("mae");
    const answer = await callTool(ctx, "POST /v1/release", { slug: "priya" });
    expect(answer).not.toContain("open work");
    expect(answer).toContain("Released Priya.");
  });

  it("posts a bet the lead opens as the office's news, to the room and the feed alike", async () => {
    const { ctx } = runAs("mae");
    const heard: Extract<ActivityEvent, { kind: "chat" }>[] = [];
    const listen = (e: ActivityEvent): void => {
      if (e.kind === "chat") {
        heard.push(e);
      }
    };
    activityEvents.on("activity", listen);
    try {
      await openBet(ctx);
      await callTool(ctx, "POST /v1/message-team", { text: "on it" });
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

  it("keeps a long bet whole in the room, capping only the feed and free-form chat", async () => {
    const { ctx } = runAs("mae");
    const hypothesis = "h".repeat(600);
    const heard: string[] = [];
    const listen = (e: ActivityEvent): void => {
      if (e.kind === "chat") {
        heard.push(e.message);
      }
    };
    activityEvents.on("activity", listen);
    try {
      await callTool(ctx, "POST /v1/open-bet", { ...BET, hypothesis });
      await callTool(ctx, "POST /v1/message-team", { text: "m".repeat(500) });
    } finally {
      activityEvents.off("activity", listen);
    }
    const news = `🎲 New bet: ${BET.title} — ${hypothesis}`;
    expect(store.recentTeamMessages().map(({ text }) => text)).toEqual([news, "m".repeat(400)]);
    expect(heard).toEqual([news.slice(0, 400), "m".repeat(400)]);
  });
});

const TOKEN = "vercel-secret-token";
const VERCEL = { projectId: "prj_1", projectName: "acme-site", teamId: "team_1" };
const BOUND_ACTION = "deploy acme to production on Vercel project acme-site";
const NEW_ACTION = "deploy acme to production on a new Vercel project named acme";
const NEW_PROJECT = { projectId: "prj_new", projectName: "acme", teamId: null };
const DEPLOYED: DeployResult = {
  alias: null,
  kind: "deployed",
  project: VERCEL,
  url: "https://acme-1.vercel.app",
};

/** A run of Priya's on Acme whose deploys answer `result`, and what each deploy was asked. */
const deployingRun = (result: DeployResult) => {
  const run = runAs("priya");
  const deploys: DeployRequest[] = [];
  const ctx: RunContext = {
    ...run.ctx,
    deploy: (req) => {
      deploys.push(req);
      return Promise.resolve(result);
    },
    run: { ...run.ctx.run, productId: "acme" },
  };
  return { ...run, ctx, deploys };
};

const connectVercel = () =>
  writeFileSync(path.join(root, "secrets.json"), JSON.stringify({ VERCEL_TOKEN: TOKEN }));

describe("deploy", () => {
  it("holds the first call for the founder's sign-off on the product and the project it lands in", async () => {
    connectVercel();
    const { ctx, asked, deploys } = deployingRun(DEPLOYED);
    store.setProductVercel("acme", VERCEL);
    expect(await callTool(ctx, "POST /v1/deploy", {})).toBe(
      `Held for the founder's sign-off on "${BOUND_ACTION}". End your turn: the task resumes on their answer, and calling the tool again then runs it.`,
    );
    expect(asked).toEqual([{ command: BOUND_ACTION, rule: "deploy", type: "approval" }]);
    expect(deploys).toEqual([]);
  });

  it("deploys once signed off, into the product's project, and spends the sign-off", async () => {
    connectVercel();
    const { ctx, deploys } = deployingRun(DEPLOYED);
    const product = store.setProductVercel("acme", VERCEL);
    store.grantApproval(ctx.run.taskId, BOUND_ACTION);

    expect(await callTool(ctx, "POST /v1/deploy", {})).toBe(
      "Deployed Acme to production: https://acme-1.vercel.app",
    );
    expect(deploys).toEqual([
      { cwd: product.workspaceDir, target: { binding: VERCEL, kind: "bound" }, token: TOKEN },
    ]);
    expect(await callTool(ctx, "POST /v1/deploy", {})).toContain("Held for the founder's sign-off");
    expect(deploys).toHaveLength(1);
  });

  it("leads with the production domain, since the deployment's own URL sits behind Vercel's login", async () => {
    connectVercel();
    const { ctx } = deployingRun({ ...DEPLOYED, alias: "https://acme.vercel.app" });
    store.setProductVercel("acme", VERCEL);
    store.grantApproval(ctx.run.taskId, BOUND_ACTION);

    expect(await callTool(ctx, "POST /v1/deploy", {})).toBe(
      "Deployed Acme to production: https://acme.vercel.app (this deployment: https://acme-1.vercel.app)",
    );
  });

  it("puts a product bound to nothing into a project named for it, and binds it there", async () => {
    connectVercel();
    const { ctx, asked, deploys } = deployingRun({ ...DEPLOYED, project: NEW_PROJECT });
    expect(await callTool(ctx, "POST /v1/deploy", {})).toContain(`sign-off on "${NEW_ACTION}"`);
    expect(asked).toEqual([{ command: NEW_ACTION, rule: "deploy", type: "approval" }]);
    store.grantApproval(ctx.run.taskId, NEW_ACTION);

    expect(await callTool(ctx, "POST /v1/deploy", {})).toBe(
      "Deployed Acme to production: https://acme-1.vercel.app\nAcme is now bound to the new Vercel project acme, which counts its visitors.",
    );
    expect(deploys.map((d) => d.target)).toEqual([{ kind: "new", name: "acme" }]);
    expect(store.getProduct("acme")?.vercel).toEqual(NEW_PROJECT);
  });

  it("binds a new project its failed deploy made, so the next deploy lands there too", async () => {
    connectVercel();
    const reason = 'Vercel\'s build failed: Command "npm run build" exited with 1.';
    const { ctx } = deployingRun({ kind: "failed", project: NEW_PROJECT, reason });
    store.grantApproval(ctx.run.taskId, NEW_ACTION);

    expect(await callTool(ctx, "POST /v1/deploy", {})).toBe(
      `The deploy of Acme failed: ${reason}\nAcme is now bound to the new Vercel project acme, which counts its visitors.`,
    );
    expect(store.getProduct("acme")?.vercel).toEqual(NEW_PROJECT);
  });

  it("leaves a binding the founder made while the deploy ran", async () => {
    connectVercel();
    const run = deployingRun(DEPLOYED);
    const ctx: RunContext = {
      ...run.ctx,
      deploy: () => {
        store.setProductVercel("acme", VERCEL);
        return Promise.resolve({ ...DEPLOYED, project: NEW_PROJECT });
      },
    };
    store.grantApproval(ctx.run.taskId, NEW_ACTION);

    expect(await callTool(ctx, "POST /v1/deploy", {})).toBe(
      "Deployed Acme to production: https://acme-1.vercel.app",
    );
    expect(store.getProduct("acme")?.vercel).toEqual(VERCEL);
  });

  it("asks the founder to bind a product whose name another Vercel project holds", async () => {
    connectVercel();
    const { ctx, asked } = deployingRun({ kind: "name-taken", name: "acme" });
    store.grantApproval(ctx.run.taskId, NEW_ACTION);

    expect(await callTool(ctx, "POST /v1/deploy", {})).toContain(
      'Vercel already has a project named "acme"',
    );
    expect(asked).toEqual([
      {
        integration: "vercel",
        reason: 'to bind Acme to its Vercel project: one named "acme" already exists',
        type: "integration",
      },
    ]);
    expect(store.getProduct("acme")?.vercel).toBeNull();
  });

  it("asks for Vercel, not a sign-off, while no key is saved", async () => {
    const { ctx, asked, deploys } = deployingRun(DEPLOYED);
    expect(await callTool(ctx, "POST /v1/deploy", {})).toContain("Vercel is not connected");
    expect(asked).toEqual([
      { integration: "vercel", reason: "to deploy Acme", type: "integration" },
    ]);
    expect(deploys).toEqual([]);
  });
});

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync("/usr/bin/git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();

const commitIn = (repo: string, message: string, ...args: string[]): string => {
  gitIn(
    repo,
    "-c",
    "user.name=Priya",
    "-c",
    "user.email=priya@acme.test",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    message,
    ...args,
  );
  return gitIn(repo, "rev-parse", "HEAD");
};

describe("push", () => {
  let remotes = "";

  beforeAll(() => {
    remotes = mkdtempSync(path.join(tmpdir(), "idlebiz-remotes-"));
  });

  beforeEach(() => {
    // the push reads the founder's own git config; this machine's must not steer the tests
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  });

  afterEach(() => vi.unstubAllEnvs());

  afterAll(() => rmSync(remotes, { force: true, recursive: true }));

  /** A run of Priya's on Acme, whose workspace is a repository with origin at a bare one on disk. */
  const pushingRun = () => {
    const run = runAs("priya");
    const workspace = store.getProduct("acme")?.workspaceDir ?? "";
    const remote = mkdtempSync(path.join(remotes, "acme-"));
    gitIn(remote, "init", "--quiet", "--bare");
    gitIn(workspace, "init", "--quiet", "--initial-branch=main");
    gitIn(workspace, "remote", "add", "origin", `file://${remote}`);
    const ctx: RunContext = {
      ...run.ctx,
      push: pusherOver(["file"]),
      run: { ...run.ctx.run, productId: "acme" },
    };
    const tip = (): string | null => {
      try {
        return gitIn(remote, "rev-parse", "--verify", "--quiet", "refs/heads/main");
      } catch {
        return null;
      }
    };
    const actionFor = (sha: string) => `push main (${sha}) of acme to file://${remote}`;
    return { ...run, actionFor, ctx, tip, workspace };
  };

  it("holds the first call for the founder's sign-off on the commit, whole, and where it goes", async () => {
    const { ctx, asked, actionFor, tip, workspace } = pushingRun();
    const sha = commitIn(workspace, "landing page");
    expect(await callTool(ctx, "POST /v1/push", {})).toBe(
      `Held for the founder's sign-off on "${actionFor(sha)}". End your turn: the task resumes on their answer, and calling the tool again then runs it.`,
    );
    expect(asked).toEqual([{ command: actionFor(sha), rule: "git-push", type: "approval" }]);
    expect(tip()).toBeNull();
  });

  it("pushes once signed off, says what git said, and spends the sign-off", async () => {
    const { ctx, actionFor, tip, workspace } = pushingRun();
    const sha = commitIn(workspace, "landing page");
    store.grantApproval(ctx.run.taskId, actionFor(sha));

    const answer = await callTool(ctx, "POST /v1/push", {});
    expect(answer).toContain("Pushed main of Acme. git said:");
    expect(answer).toContain("main -> main");
    expect(tip()).toBe(sha);
    expect(await callTool(ctx, "POST /v1/push", {})).toContain("Held for the founder's sign-off");
  });

  it("pushes no commit but the one signed for", async () => {
    const { ctx, asked, actionFor, tip, workspace } = pushingRun();
    const signed = commitIn(workspace, "landing page");
    store.grantApproval(ctx.run.taskId, actionFor(signed));
    const moved = commitIn(workspace, "and one more thing");

    expect(await callTool(ctx, "POST /v1/push", {})).toContain(`sign-off on "${actionFor(moved)}"`);
    expect(asked).toEqual([{ command: actionFor(moved), rule: "git-push", type: "approval" }]);
    expect(tip()).toBeNull();
    expect(store.consumeApproval(ctx.run.taskId, actionFor(signed))).toBe(true);
  });

  it("answers a push git rejects with git's words, and spends the sign-off", async () => {
    const { ctx, actionFor, tip, workspace } = pushingRun();
    const first = commitIn(workspace, "landing page");
    store.grantApproval(ctx.run.taskId, actionFor(first));
    await callTool(ctx, "POST /v1/push", {});
    const rewritten = commitIn(workspace, "landing page, reworded", "--amend");
    store.grantApproval(ctx.run.taskId, actionFor(rewritten));

    const answer = await callTool(ctx, "POST /v1/push", {});
    expect(answer).toContain("git did not push main of Acme, and the sign-off is spent");
    expect(answer).toContain("[rejected]");
    expect(tip()).toBe(first);
    expect(store.consumeApproval(ctx.run.taskId, actionFor(rewritten))).toBe(false);
  });

  it("refuses a remote it would not reach before asking the founder anything", async () => {
    const { ctx, asked, workspace } = pushingRun();
    commitIn(workspace, "landing page");
    gitIn(workspace, "remote", "set-url", "origin", "ext::sh");
    expect(await callTool(ctx, "POST /v1/push", {})).toContain(
      "which the push tool does not reach",
    );
    expect(asked).toEqual([]);
  });
});

const LINK = { amountUsd: 9, name: "Pro plan" };
const PAID_URL = "https://buy.stripe.com/pro";

/** Stripe, as far as a payment link goes: every form it was sent, by endpoint. */
const fakeStripe = () => {
  const sent: { endpoint: string; auth: string | null; form: Record<string, string> }[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    const endpoint = new URL(url).pathname;
    sent.push({
      auth: new Headers(init.headers).get("Authorization"),
      endpoint,
      form: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {},
    });
    return Promise.resolve(
      Response.json(endpoint === "/v1/prices" ? { id: "price_1" } : { url: PAID_URL }),
    );
  });
  return sent;
};

/** A run of Priya's on Acme that charges through the fake Stripe, with the founder's key saved. */
const chargingRun = (key: string | null = "sk_live_founder") => {
  if (key !== null) {
    writeFileSync(path.join(root, "secrets.json"), JSON.stringify({ STRIPE_SECRET_KEY: key }));
  }
  const run = runAs("priya");
  const stripe = fakeStripe();
  const ctx: RunContext = {
    ...run.ctx,
    createPaymentLink: stripePaymentLink,
    run: { ...run.ctx.run, productId: "acme" },
  };
  return { ...run, ctx, stripe };
};

const revenueBet = (productId = "acme") =>
  store.openBet({ ...BET, metric: "revenue", productId, target: 20, title: "Paid tier" });

describe("create_payment_link", () => {
  it("holds the first call for the founder's sign-off, and asks Stripe nothing", async () => {
    const { ctx, asked, stripe } = chargingRun();
    const bet = revenueBet();
    const action = `payment link "Pro plan" at $9.00 on acme for bet ${bet.id}`;

    expect(await callTool(ctx, "POST /v1/payment-link", { ...LINK, bet: bet.id })).toBe(
      `Held for the founder's sign-off on "${action}". End your turn: the task resumes on their answer, and calling the tool again then runs it.`,
    );
    expect(asked).toEqual([{ command: action, rule: "payments", type: "approval" }]);
    expect(stripe).toEqual([]);
  });

  it("once signed off, prices it in cents and tags the payment for the product and the bet", async () => {
    const { ctx, stripe } = chargingRun();
    const bet = revenueBet();
    store.grantApproval(
      ctx.run.taskId,
      `payment link "Pro plan" at $9.00 on acme for bet ${bet.id}`,
    );

    expect(await callTool(ctx, "POST /v1/payment-link", { ...LINK, bet: bet.id })).toBe(
      `Created a payment link for "Pro plan" at $9.00 on Acme: ${PAID_URL}`,
    );
    expect(stripe).toEqual([
      {
        auth: "Bearer sk_live_founder",
        endpoint: "/v1/prices",
        form: { currency: "usd", "product_data[name]": "Pro plan", unit_amount: "900" },
      },
      {
        auth: "Bearer sk_live_founder",
        endpoint: "/v1/payment_links",
        form: {
          "line_items[0][price]": "price_1",
          "line_items[0][quantity]": "1",
          "metadata[bet]": bet.id,
          "metadata[product]": "acme",
          "payment_intent_data[metadata][bet]": bet.id,
          "payment_intent_data[metadata][product]": "acme",
        },
      },
    ]);
    expect(await callTool(ctx, "POST /v1/payment-link", { ...LINK, bet: bet.id })).toContain(
      "Held for the founder's sign-off",
    );
    expect(stripe).toHaveLength(2);
  });

  it("tags the product alone when no bet is named, charging whole cents", async () => {
    const { ctx, stripe } = chargingRun();
    const side = store.createProduct({ description: "a side project", name: "Side" });
    store.grantApproval(ctx.run.taskId, `payment link "Pro plan" at $12.50 on ${side.id}`);

    const answer = await callTool(ctx, "POST /v1/payment-link", {
      amountUsd: 12.499,
      name: "  Pro plan ",
      product: side.id,
    });

    expect(answer).toContain(PAID_URL);
    expect(stripe.map(({ form }) => form)).toMatchObject([
      { unit_amount: "1250" },
      { "metadata[product]": side.id, "payment_intent_data[metadata][product]": side.id },
    ]);
    expect(Object.keys(stripe[1]?.form ?? {})).not.toContain("metadata[bet]");
  });

  it("quotes the name in what the founder signs, so it cannot pose as the price", async () => {
    const { ctx, asked } = chargingRun();
    await callTool(ctx, "POST /v1/payment-link", { amountUsd: 500, name: 'Tip" at $1.00 on acme' });
    expect(asked).toEqual([
      {
        command: String.raw`payment link "Tip\" at $1.00 on acme" at $500.00 on acme`,
        rule: "payments",
        type: "approval",
      },
    ]);
  });

  it.each([
    { hidden: "\u202E", what: "a direction override" },
    { hidden: "\u200B", what: "a zero-width space" },
    { hidden: "\n", what: "a line break" },
  ])(
    "refuses a name holding $what, which could redraw the price the founder reads",
    async ({ hidden }) => {
      const { ctx, asked, stripe } = chargingRun();
      const name = `Tip ${hidden}emca no 00.1$ ta `;
      await expect(
        callTool(ctx, "POST /v1/payment-link", { amountUsd: 500, name }),
      ).rejects.toThrow(BadRequestError);
      expect(asked).toEqual([]);
      expect(stripe).toEqual([]);
    },
  );

  it("leaves the founder a Stripe card, not a sign-off, while IdleBiz has no key", async () => {
    const { ctx, asked, stripe } = chargingRun(null);
    const answer = await callTool(ctx, "POST /v1/payment-link", LINK);
    expect(answer).toContain("a Stripe card waiting that takes them to the Budget panel");
    expect(answer).toContain("this task resumes automatically once the key is saved");
    expect(asked).toEqual([
      {
        integration: "stripe",
        reason: 'to sell "Pro plan" at $9.00 through a payment link',
        type: "integration",
      },
    ]);
    expect(stripe).toEqual([]);
  });

  it("raises no card for a link it could not make anyway", async () => {
    const { ctx, asked } = chargingRun(null);
    expect(await callTool(ctx, "POST /v1/payment-link", { ...LINK, bet: "no-such-bet" })).toContain(
      "is not an open revenue bet",
    );
    expect(asked).toEqual([]);
  });

  it("refuses a bet whose money the link could not be counted for", async () => {
    const { ctx, asked, stripe } = chargingRun();
    const side = store.createProduct({ description: "a side project", name: "Side" });
    const elsewhere = revenueBet(side.id);
    const visitors = store.openBet({
      ...BET,
      landingPath: null,
      metric: "users",
      productId: "acme",
    });
    const killed = revenueBet();
    store.killBet(killed.id, "dud", Date.now());

    for (const bet of [elsewhere, visitors, killed, { id: "no-such-bet" }]) {
      expect(await callTool(ctx, "POST /v1/payment-link", { ...LINK, bet: bet.id })).toBe(
        `"${bet.id}" is not an open revenue bet on acme — read_bets lists every live bet, what it counts and its product.`,
      );
    }
    expect(asked).toEqual([]);
    expect(stripe).toEqual([]);
  });

  it("says a test key's link takes no real money", async () => {
    const { ctx } = chargingRun("sk_test_founder");
    store.grantApproval(ctx.run.taskId, 'payment link "Pro plan" at $9.00 on acme');
    expect(await callTool(ctx, "POST /v1/payment-link", LINK)).toBe(
      `Created a payment link for "Pro plan" at $9.00 on Acme: ${PAID_URL} Stripe is in test mode: the link takes no real money, and what it takes counts for nothing unless IdleBiz runs with IDLEBIZ_COUNT_TEST_MONEY=1.`,
    );
  });

  it("answers with Stripe's own reason when it makes no link", async () => {
    const { ctx } = chargingRun();
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json(
          { error: { message: "Your account cannot currently make live charges." } },
          { status: 400 },
        ),
      ),
    );
    store.grantApproval(ctx.run.taskId, 'payment link "Pro plan" at $9.00 on acme');
    expect(await callTool(ctx, "POST /v1/payment-link", LINK)).toBe(
      "Stripe made no payment link: Your account cannot currently make live charges.",
    );
  });
});
