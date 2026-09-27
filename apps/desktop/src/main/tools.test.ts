import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActivityEvent } from "@/shared/activity";
import type { BlockedAsk, TaskOrigin } from "@/shared/domain";
import { BadRequestError } from "@/shared/errors";
import type { DeployRequest, DeployResult } from "./deploy";
import type { CatalogQuery, CatalogRead } from "./printful";
import type { RunContext } from "./tools";
import type { EnvRequest, EnvResult } from "./vercel-env";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-tools-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const store = await import("./store/store");
const { askBox } = await import("./agents/agent-driver");
const { callTool } = await import("./tools");
const { stripePaymentLink } = await import("./payment-links");
const { printListing } = await import("./print-listing");
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
    printListing: {
      catalog: () =>
        Promise.reject(new Error("read Printful's catalog without a test asking for it")),
      hosts: () =>
        Promise.reject(new Error("asked Vercel for domains without a test asking for it")),
      publish: () => Promise.reject(new Error("listed a print without a test asking for it")),
      quote: () =>
        Promise.reject(new Error("asked Printful for a price without a test asking for it")),
      readFile: () =>
        Promise.reject(new Error("fetched a print file without a test asking for it")),
      stripeAccess: () =>
        Promise.reject(new Error("asked Stripe about its grants without a test asking for it")),
    },
    run: { betId: null, origin: "founder", productId: null, runId: "run", taskId: "task" },
    setEnv: () => Promise.reject(new Error("set a variable without a test asking for it")),
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
    expect(
      await callTool(ctx, "POST /v1/request-integration", { kind: "vercel", reason: "to deploy" }),
    ).toContain("The founder was not asked");
    expect(asked).toEqual([{ question: "Ship it?", type: "question" }]);
    expect(ctx.asks.current()).toEqual({ question: "Ship it?", type: "question" });
  });

  it("hands the founder an action, and says when a second ask of the run went nowhere", async () => {
    const { ctx, asked } = runAs("priya");
    const card = await callTool(ctx, "POST /v1/ask-boss", {
      action: "Post the launch thread",
      instructions: "Post it on r/SideProject and send me its URL.",
    });
    const second = await callTool(ctx, "POST /v1/ask-boss", { question: "Ship it?" });
    expect(card).toContain("action card");
    expect(second).toContain("The founder was not asked");
    expect(asked).toEqual([
      {
        action: "Post the launch thread",
        draft: null,
        instructions: "Post it on r/SideProject and send me its URL.",
        type: "action",
      },
    ]);
  });

  it.each([null, "", "  "])("takes a draft of %j as none", async (draft) => {
    const { ctx, asked } = runAs("priya");
    await callTool(ctx, "POST /v1/ask-boss", {
      action: "Buy acme.dev",
      draft,
      instructions: "...",
    });
    expect(asked).toMatchObject([{ draft: null, type: "action" }]);
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
      {
        cwd: product.workspaceDir,
        target: { binding: VERCEL, kind: "bound" },
        token: TOKEN,
        unshippable: [],
      },
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

  it("refuses a folder holding a key set_env set before the founder is asked to sign off", async () => {
    connectVercel();
    const { ctx, asked, deploys } = deployingRun(DEPLOYED);
    const product = store.setProductVercel("acme", VERCEL);
    const key = "sk-proj-acme-runtime";
    writeFileSync(
      path.join(root, "secrets.json"),
      JSON.stringify({
        [`ENV/${product.companyId}/acme/OPENAI_API_KEY`]: key,
        VERCEL_TOKEN: TOKEN,
      }),
    );
    writeFileSync(path.join(product.workspaceDir, "ai.js"), `const key = "${key}";`);

    expect(await callTool(ctx, "POST /v1/deploy", {})).toBe(
      "Nothing was deployed: ai.js holds the value set_env set as OPENAI_API_KEY on acme, and a deploy would publish it. Take it out of the folder, read it from process.env.OPENAI_API_KEY instead, then deploy again.",
    );
    expect(asked).toEqual([]);
    expect(deploys).toEqual([]);
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

const OPENAI = { name: "OPENAI_API_KEY", value: "sk-proj-acme-runtime" };

const SET: EnvResult = { ok: true };

/** A run of Priya's on Acme whose variables answer `result`, and what each was asked. */
const settingRun = (result: EnvResult = SET) => {
  const run = runAs("priya");
  const sets: EnvRequest[] = [];
  const ctx: RunContext = {
    ...run.ctx,
    run: { ...run.ctx.run, productId: "acme" },
    setEnv: (req) => {
      sets.push(req);
      return Promise.resolve(result);
    },
  };
  return { ...run, ctx, sets };
};

describe("set_env", () => {
  it("sets the variable on the run's product's project with the founder's token, unsigned, and says when it takes effect", async () => {
    connectVercel();
    const { ctx, asked, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);

    const answer = await callTool(ctx, "POST /v1/set-env", OPENAI);
    expect(answer).toBe(
      "Set OPENAI_API_KEY on Acme's Vercel project acme-site, for production and preview. It takes effect on the next deploy; server code reads it as process.env.OPENAI_API_KEY. Never write its value into a file: deploy refuses a folder that holds it.",
    );
    expect(sets).toEqual([
      {
        binding: VERCEL,
        name: "OPENAI_API_KEY",
        replaces: false,
        token: TOKEN,
        value: OPENAI.value,
      },
    ]);
    expect(asked).toEqual([]);
    expect(store.recentTeamMessages().map(({ text }) => text)).toEqual([
      "🔑 set OPENAI_API_KEY on Acme",
    ]);
  });

  it("keeps the value in secrets.json, out of the save, and hands it to the next deploy to refuse", async () => {
    connectVercel();
    const { ctx } = settingRun();
    store.setProductVercel("acme", VERCEL);
    await callTool(ctx, "POST /v1/set-env", OPENAI);
    const deploys: DeployRequest[] = [];
    const deploying: RunContext = {
      ...ctx,
      deploy: (req) => {
        deploys.push(req);
        return Promise.resolve(DEPLOYED);
      },
    };
    store.grantApproval(ctx.run.taskId, BOUND_ACTION);

    await callTool(deploying, "POST /v1/deploy", {});
    expect(deploys[0]?.unshippable).toEqual([
      { ...OPENAI, company: store.requireCompany().id, product: "acme" },
    ]);
    const saved = readdirSync(root, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name !== "secrets.json",
    );
    expect(saved.length).toBeGreaterThan(0);
    for (const entry of saved) {
      expect(readFileSync(path.join(entry.parentPath, entry.name), "utf-8")).not.toContain(
        OPENAI.value,
      );
    }
  });

  it("replaces only a name the team set, and keeps nothing Vercel turned down", async () => {
    connectVercel();
    const refused = settingRun({
      error: "Vercel turned it down (403): A variable with this name already exists",
      ok: false,
    });
    store.setProductVercel("acme", VERCEL);

    expect(await callTool(refused.ctx, "POST /v1/set-env", OPENAI)).toBe(
      "OPENAI_API_KEY was not set on Acme: Vercel turned it down (403): A variable with this name already exists\nset_env only replaces a variable the team set: if acme-site already has OPENAI_API_KEY, it is the founder's, so hand them an ask_boss action to change it.",
    );
    expect(store.recentTeamMessages()).toEqual([]);

    const sets: EnvRequest[] = [];
    const ctx: RunContext = {
      ...refused.ctx,
      setEnv: (req) => {
        sets.push(req);
        return Promise.resolve(SET);
      },
    };
    await callTool(ctx, "POST /v1/set-env", OPENAI);
    await callTool(ctx, "POST /v1/set-env", { ...OPENAI, value: "sk-proj-acme-rotated" });
    expect([...refused.sets, ...sets].map((req) => req.replaces)).toEqual([false, false, true]);
  });

  it("sends the value without the whitespace a paste carries", async () => {
    connectVercel();
    const { ctx, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);

    await callTool(ctx, "POST /v1/set-env", { ...OPENAI, value: ` ${OPENAI.value}\n` });
    expect(sets[0]?.value).toBe(OPENAI.value);
  });

  it("tells a run whose product has no project yet to deploy first", async () => {
    connectVercel();
    const { ctx, sets } = settingRun();

    expect(await callTool(ctx, "POST /v1/set-env", OPENAI)).toBe(
      "Acme has no Vercel project yet: deploy it first, which makes one, then set OPENAI_API_KEY.",
    );
    expect(sets).toEqual([]);
  });

  it("asks for Vercel while no key is saved", async () => {
    const { ctx, asked, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);

    expect(await callTool(ctx, "POST /v1/set-env", OPENAI)).toContain("Vercel is not connected");
    expect(asked).toEqual([
      { integration: "vercel", reason: "to set OPENAI_API_KEY on Acme", type: "integration" },
    ]);
    expect(sets).toEqual([]);
  });

  it("refuses a name Vercel keeps, or one the page would show, as the caller's error", async () => {
    connectVercel();
    const { ctx, sets } = settingRun();
    store.setProductVercel("acme", VERCEL);

    for (const name of ["VERCEL_URL", "NODE_ENV", "NEXT_PUBLIC_KEY", "openai_key"]) {
      await expect(callTool(ctx, "POST /v1/set-env", { ...OPENAI, name })).rejects.toThrow(
        BadRequestError,
      );
    }
    expect(sets).toEqual([]);
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

  it("says a sign-off was never asked for when the run already asked the founder something", async () => {
    const { ctx, asked, stripe } = chargingRun();
    await callTool(ctx, "POST /v1/ask-boss", { action: "Verify the email", instructions: "..." });

    const held = await callTool(ctx, "POST /v1/payment-link", LINK);
    expect(held).toContain(`Held for the founder's sign-off on "payment link`);
    expect(held).toContain("The founder was not asked");
    expect(held).not.toContain("the task resumes on their answer");
    expect(asked).toMatchObject([{ type: "action" }]);
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
      `Created a payment link for "Pro plan" at $9.00 on Acme: ${PAID_URL} Nothing names a delivery, so a buyer gets only Stripe's receipt.`,
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

  it("keeps a delivery on the link alone, where each checkout carries it to the founder's card", async () => {
    const { ctx, stripe } = chargingRun();
    store.grantApproval(ctx.run.taskId, 'payment link "Pro plan" at $9.00 on acme');

    const answer = await callTool(ctx, "POST /v1/payment-link", {
      ...LINK,
      delivery: " Email the licence key from keys.txt ",
    });

    expect(answer).toContain("The founder gets a card for each paid checkout");
    expect(stripe[1]?.form).toMatchObject({
      "metadata[delivery]": "Email the licence key from keys.txt",
      "metadata[product]": "acme",
    });
    expect(Object.keys(stripe[1]?.form ?? {})).not.toContain(
      "payment_intent_data[metadata][delivery]",
    );
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
      `Created a payment link for "Pro plan" at $9.00 on Acme: ${PAID_URL} Nothing names a delivery, so a buyer gets only Stripe's receipt. Stripe is in test mode: the link takes no real money, and what it takes counts for nothing unless IdleBiz runs with IDLEBIZ_COUNT_TEST_MONEY=1.`,
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

const PRINT = {
  name: "Launch tee",
  placements: [
    {
      fileUrl: "https://acme-site.vercel.app/print/tee-1.png",
      placement: "front",
      technique: "dtg",
    },
  ],
  priceUsd: 28,
  variantIds: [4012, 4013],
};
/** The print file the product's site serves, and its digest, which the founder signs for. */
const DESIGN = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]);
const DESIGN_SHA = createHash("sha256").update(DESIGN).digest("hex");
const PRINT_ACTION = `sell "Launch tee" (variants 4012, 4013) printing front (dtg) https://acme-site.vercel.app/print/tee-1.png sha256:${DESIGN_SHA} at $28.00 via Printful on acme`;
const LISTED_URL = "https://buy.stripe.com/tee";

interface Sent {
  host: string;
  method: string;
  path: string;
  form: Record<string, string>;
  idempotencyKey: string | null;
}

/** Stripe's answer to a key reading a list, one it grants or turned away with `status`. */
const listAnswer = (status: number): Response =>
  status === 200
    ? Response.json({ data: [] })
    : Response.json(
        {
          error: {
            message: "The provided key does not have the required permissions for this endpoint.",
          },
        },
        { status },
      );

/** Stripe's answer to a key reading checkouts or shipping rates, as the key's grants have it. */
const stripeRead = (pathname: string, grants: { checkouts: number; shippingRates: number }) =>
  listAnswer(pathname === "/v1/checkout/sessions" ? grants.checkouts : grants.shippingRates);

/**
 * Vercel, the product's own site, Printful and Stripe, as far as listing a print goes. Printful
 * charges $16.40 to California and $18.20 elsewhere, $4.75 and $7.99 of it shipping, and
 * finishes each estimate as soon as it is asked.
 */
const fakeSellers = ({
  fileType = "image/png",
  linkTimesOut = false,
  shippingRates = 200,
  checkouts = 200,
} = {}) => {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const { host, pathname } = new URL(url);
    const method = init?.method ?? "GET";
    sent.push({
      form: init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {},
      host,
      idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      method,
      path: pathname,
    });
    if (host === "api.vercel.com") {
      return Promise.resolve(
        Response.json({ domains: [{ name: "acme-site.vercel.app", verified: true }] }),
      );
    }
    if (host === "acme-site.vercel.app") {
      return Promise.resolve(new Response(DESIGN, { headers: { "content-type": fileType } }));
    }
    if (host === "api.stripe.com" && method === "GET") {
      return Promise.resolve(stripeRead(pathname, { checkouts, shippingRates }));
    }
    if (host === "api.printful.com" && pathname.startsWith("/v2/catalog-variants/")) {
      const id = Number(pathname.split("/").at(-1));
      return Promise.resolve(
        Response.json({
          data: {
            catalog_product_id: 71,
            color: "Black",
            id,
            name: "Tee",
            size: id === 4012 ? "S" : "M",
          },
        }),
      );
    }
    if (host === "api.printful.com") {
      const california = z.string().parse(init?.body).includes('"CA"');
      const costs = california
        ? { currency: "USD", shipping: "4.75", total: "16.40" }
        : { currency: "USD", shipping: "7.99", total: "18.20" };
      return Promise.resolve(
        Response.json({ data: { costs, failure_reasons: [], id: "t", status: "completed" } }),
      );
    }
    if (linkTimesOut && pathname === "/v1/payment_links") {
      return Promise.resolve(new Response(null, { status: 504 }));
    }
    const made = new Map([
      ["/v1/payment_links", { id: "plink_1", url: LISTED_URL }],
      ["/v1/prices", { id: "price_1" }],
      ["/v1/shipping_rates", { id: "shr_1" }],
    ]).get(pathname);
    return Promise.resolve(Response.json(made ?? {}, { status: made ? 200 : 404 }));
  });
  return sent;
};

type Keys = Partial<Record<"stripe" | "vercel" | "printful", boolean>>;

/** A run of Priya's on Acme, bound to its Vercel project, with the founder's keys saved but those `missing`. */
const sellingRun = (missing: Keys = {}, sellers: Parameters<typeof fakeSellers>[0] = {}) => {
  const secrets = new Map<string, string>();
  if (!missing.stripe) {
    secrets.set("STRIPE_SECRET_KEY", "sk_test_founder");
  }
  if (!missing.vercel) {
    secrets.set("VERCEL_TOKEN", TOKEN);
  }
  if (!missing.printful) {
    secrets.set("PRINTFUL_STORE", JSON.stringify({ id: 42, name: "Acme Prints" }));
    secrets.set("PRINTFUL_TOKEN", "pf_founder_token");
  }
  writeFileSync(path.join(root, "secrets.json"), JSON.stringify(Object.fromEntries(secrets)));
  const run = runAs("priya");
  store.setProductVercel("acme", VERCEL);
  const sent = fakeSellers(sellers);
  const ctx: RunContext = { ...run.ctx, printListing, run: { ...run.ctx.run, productId: "acme" } };
  return { ...run, ctx, sent };
};

const outward = (sent: readonly Sent[]) => sent.filter((s) => s.method === "POST");

describe("sell_print", () => {
  it("prices it with Printful, then holds it for the founder's sign-off before Stripe is asked", async () => {
    const { ctx, asked, sent } = sellingRun();

    expect(await callTool(ctx, "POST /v1/sell-print", PRINT)).toBe(
      `Held for the founder's sign-off on "${PRINT_ACTION}". End your turn: the task resumes on their answer, and calling the tool again then runs it.`,
    );
    expect(asked).toEqual([{ command: PRINT_ACTION, rule: "payments", type: "approval" }]);
    expect(outward(sent).map((s) => s.host)).not.toContain("api.stripe.com");
    expect(outward(sent)).toHaveLength(6);
    expect(
      sent.filter((s) => s.host === "api.stripe.com" && s.method === "GET").map((s) => s.path),
    ).toEqual(["/v1/shipping_rates", "/v1/checkout/sessions"]);
  });

  it("once signed off, lists it on a US-only link at Printful's shipping, tagged and saved", async () => {
    const { ctx, sent } = sellingRun();
    const bet = revenueBet();
    const action = `${PRINT_ACTION} for bet ${bet.id}`;
    store.grantApproval(ctx.run.taskId, action);

    const answer = await callTool(ctx, "POST /v1/sell-print", { ...PRINT, bet: bet.id });

    expect(answer).toBe(
      `Listed "Launch tee" on Acme at $28.00 plus $7.99 shipping, US addresses only: ${LISTED_URL}\nPrintful charges up to $18.20 for each one it prints and ships. Each paid order goes to Printful on its own; read_orders shows them. Stripe is in test mode: the link takes no real money, and what it takes counts for nothing unless IdleBiz runs with IDLEBIZ_COUNT_TEST_MONEY=1.`,
    );
    const tags = { bet: bet.id, listing: "launch-tee", product: "acme" };
    const stripe = outward(sent).filter((s) => s.host === "api.stripe.com");
    for (const { idempotencyKey } of stripe) {
      expect(idempotencyKey).toMatch(/^idlebiz-[0-9a-f]{64}$/u);
    }
    expect(
      stripe.map((s) => ({ form: s.form, host: s.host, method: s.method, path: s.path })),
    ).toEqual([
      {
        form: { currency: "usd", "product_data[name]": "Launch tee", unit_amount: "2800" },
        host: "api.stripe.com",
        method: "POST",
        path: "/v1/prices",
      },
      {
        form: {
          display_name: "Standard shipping",
          "fixed_amount[amount]": "799",
          "fixed_amount[currency]": "usd",
          type: "fixed_amount",
        },
        host: "api.stripe.com",
        method: "POST",
        path: "/v1/shipping_rates",
      },
      {
        form: {
          "custom_fields[0][dropdown][options][0][label]": "Black / S",
          "custom_fields[0][dropdown][options][0][value]": "4012",
          "custom_fields[0][dropdown][options][1][label]": "Black / M",
          "custom_fields[0][dropdown][options][1][value]": "4013",
          "custom_fields[0][key]": "variant",
          "custom_fields[0][label][custom]": "Option",
          "custom_fields[0][label][type]": "custom",
          "custom_fields[0][type]": "dropdown",
          "line_items[0][price]": "price_1",
          "line_items[0][quantity]": "1",
          ...Object.fromEntries(Object.entries(tags).map(([k, v]) => [`metadata[${k}]`, v])),
          ...Object.fromEntries(
            Object.entries(tags).map(([k, v]) => [`payment_intent_data[metadata][${k}]`, v]),
          ),
          "shipping_address_collection[allowed_countries][0]": "US",
          "shipping_options[0][shipping_rate]": "shr_1",
        },
        host: "api.stripe.com",
        method: "POST",
        path: "/v1/payment_links",
      },
    ]);
    const listing = {
      betId: bet.id,
      costCents: 1820,
      id: "launch-tee",
      livemode: false,
      name: "Launch tee",
      paymentLink: { id: "plink_1", url: LISTED_URL },
      placements: [{ ...PRINT.placements[0], sha256: DESIGN_SHA }],
      priceCents: 2800,
      productId: "acme",
      shippingCents: 799,
      variants: [
        { id: 4012, label: "Black / S" },
        { id: 4013, label: "Black / M" },
      ],
    };
    expect(store.listListings()).toMatchObject([listing]);
    store.initStore();
    expect(store.listListings()).toMatchObject([listing]);
    expect(await callTool(ctx, "POST /v1/sell-print", { ...PRINT, bet: bet.id })).toContain(
      "Held for the founder's sign-off",
    );
  });

  it("gives one variant no choice on the payment page", async () => {
    const { ctx, sent } = sellingRun();
    store.grantApproval(
      ctx.run.taskId,
      PRINT_ACTION.replace("variants 4012, 4013", "variants 4012"),
    );

    await callTool(ctx, "POST /v1/sell-print", { ...PRINT, variantIds: [4012] });

    const link = sent.find((s) => s.path === "/v1/payment_links");
    expect(Object.keys(link?.form ?? {}).filter((k) => k.startsWith("custom_fields"))).toEqual([]);
    expect(link?.form).not.toHaveProperty("metadata[bet]");
  });

  it.each([11.35, 11.36])(
    "refuses $%s, a price that loses money, naming the lowest that does not, and asks nobody",
    async (priceUsd) => {
      const { ctx, asked, sent } = sellingRun();

      // (1820 + 30) / 0.956 = 1935.1…, less the $7.99 the buyer pays for shipping
      expect(await callTool(ctx, "POST /v1/sell-print", { ...PRINT, priceUsd })).toBe(
        `$${priceUsd} would lose money on every sale: Printful charges up to $18.20 to print one and ship it in the US, the buyer pays $7.99 of that as shipping, and Stripe keeps up to 4.4% + $0.30. The lowest price that loses nothing is $11.37: price it above that, with the margin the bet needs.`,
      );
      expect(asked).toEqual([]);
      expect(sent.map((s) => s.host)).not.toContain("api.stripe.com");
    },
  );

  it("takes a price exactly at the floor to the founder", async () => {
    const { ctx, asked } = sellingRun();
    await callTool(ctx, "POST /v1/sell-print", { ...PRINT, priceUsd: 11.37 });
    expect(asked).toEqual([
      {
        command: PRINT_ACTION.replace("$28.00", "$11.37"),
        rule: "payments",
        type: "approval",
      },
    ]);
  });

  it("lists on a live key, since each paid order reaches Printful", async () => {
    const { ctx } = sellingRun();
    writeFileSync(
      path.join(root, "secrets.json"),
      JSON.stringify({
        PRINTFUL_STORE: JSON.stringify({ id: 42, name: "Acme Prints" }),
        PRINTFUL_TOKEN: "pf_founder_token",
        STRIPE_SECRET_KEY: "rk_live_founder",
        VERCEL_TOKEN: TOKEN,
      }),
    );
    fakeSellers();
    store.grantApproval(ctx.run.taskId, PRINT_ACTION);

    const answer = await callTool(ctx, "POST /v1/sell-print", PRINT);

    expect(answer).toContain(`Listed "Launch tee" on Acme at $28.00`);
    expect(answer).not.toContain("test mode");
    expect(store.listListings()).toMatchObject([{ id: "launch-tee", livemode: true }]);
  });

  it.each([
    { grants: { shippingRates: 403 }, why: "make shipping rates" },
    { grants: { checkouts: 403 }, why: "read the checkouts that find each paid order" },
  ])(
    "asks the founder to fix a Stripe key that cannot $why before they sign",
    async ({ grants }) => {
      const { ctx, asked, sent } = sellingRun({}, grants);

      expect(await callTool(ctx, "POST /v1/sell-print", PRINT)).toContain(
        "Stripe won't let IdleBiz's key make shipping rates or read checkouts: the founder has a Stripe card waiting",
      );
      expect(asked).toMatchObject([{ integration: "stripe", type: "integration" }]);
      expect(outward(sent).map((s) => s.host)).not.toContain("api.stripe.com");
    },
  );

  it("asks again once the design behind the signed URL has changed", async () => {
    const { ctx, asked, sent } = sellingRun();
    store.grantApproval(ctx.run.taskId, PRINT_ACTION.replace(DESIGN_SHA, "0".repeat(64)));

    expect(await callTool(ctx, "POST /v1/sell-print", PRINT)).toContain(
      "Held for the founder's sign-off",
    );
    expect(asked).toEqual([{ command: PRINT_ACTION, rule: "payments", type: "approval" }]);
    expect(outward(sent).map((s) => s.host)).not.toContain("api.stripe.com");
  });

  it("sends Stripe the same keys when a listing is tried again, so nothing is made twice", async () => {
    const { ctx } = sellingRun();
    const keysOf = async () => {
      const sent = fakeSellers({ linkTimesOut: true });
      store.grantApproval(ctx.run.taskId, PRINT_ACTION);
      expect(await callTool(ctx, "POST /v1/sell-print", PRINT)).toContain(
        "Stripe made no payment link",
      );
      return outward(sent)
        .filter((s) => s.host === "api.stripe.com")
        .map((s) => s.idempotencyKey);
    };

    const first = await keysOf();
    expect(first).toHaveLength(3);
    expect(await keysOf()).toEqual(first);
    expect(store.listListings()).toEqual([]);
  });

  it.each([
    {
      said: "http://acme-site.vercel.app/print/tee-1.png is not https",
      url: "http://acme-site.vercel.app/print/tee-1.png",
    },
    {
      said: "carries a login",
      url: "https://me:pw@acme-site.vercel.app/print/tee-1.png",
    },
    {
      said: "https://cdn.example.com/tee.png is not on Acme's production domains (acme-site.vercel.app)",
      url: "https://cdn.example.com/tee.png",
    },
  ])("refuses a print file Printful should not fetch: $said", async ({ said, url }) => {
    const { ctx, asked, sent } = sellingRun();
    const placements = [{ ...PRINT.placements[0], fileUrl: url }];
    expect(await callTool(ctx, "POST /v1/sell-print", { ...PRINT, placements })).toContain(said);
    expect(asked).toEqual([]);
    expect(outward(sent)).toEqual([]);
  });

  it("refuses a file the site answers with its page rather than an image", async () => {
    const { ctx, sent } = sellingRun({}, { fileType: "text/html" });
    expect(await callTool(ctx, "POST /v1/sell-print", PRINT)).toBe(
      "Printful could not fetch https://acme-site.vercel.app/print/tee-1.png: it serves text/html, not an image. Deploy the print file first, and check it loads as an image.",
    );
    expect(outward(sent)).toEqual([]);
  });

  it.each([
    {
      ask: {
        integration: "printful",
        reason: 'to print and ship "Launch tee"',
        type: "integration",
      },
      missing: { printful: true },
      said: "a Printful card waiting that takes them to the Budget panel",
    },
    {
      ask: {
        integration: "stripe",
        reason: 'to sell "Launch tee" at $28.00 through a payment link',
        type: "integration",
      },
      missing: { stripe: true },
      said: "a Stripe card waiting",
    },
    {
      ask: {
        integration: "vercel",
        reason: "to check where Acme serves its print files",
        type: "integration",
      },
      missing: { vercel: true },
      said: "Vercel is not connected",
    },
  ])(
    "leaves the founder a card for a missing $ask.integration key",
    async ({ ask, missing, said }) => {
      const { ctx, asked, sent } = sellingRun(missing);
      expect(await callTool(ctx, "POST /v1/sell-print", PRINT)).toContain(said);
      expect(asked).toEqual([ask]);
      expect(sent).toEqual([]);
    },
  );

  it("asks for a new Printful token once Printful turns the saved one away", async () => {
    const { ctx, asked } = sellingRun();
    const answers = new Map([
      ["api.printful.com", () => Response.json({ detail: "expired" }, { status: 401 })],
      [
        "api.vercel.com",
        () => Response.json({ domains: [{ name: "acme-site.vercel.app", verified: true }] }),
      ],
      [
        "acme-site.vercel.app",
        () => new Response(DESIGN, { headers: { "content-type": "image/png" } }),
      ],
    ]);
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve(answers.get(new URL(url).host)?.() ?? new Response(null, { status: 404 })),
    );

    expect(await callTool(ctx, "POST /v1/sell-print", PRINT)).toContain(
      "Printful turned IdleBiz's token away, which happens when it expires",
    );
    expect(asked).toMatchObject([{ integration: "printful", type: "integration" }]);
  });

  it("refuses a bet whose money the listing could not be counted for", async () => {
    const { ctx, sent } = sellingRun();
    expect(await callTool(ctx, "POST /v1/sell-print", { ...PRINT, bet: "no-such-bet" })).toContain(
      '"no-such-bet" is not an open revenue bet on acme',
    );
    expect(sent).toEqual([]);
  });

  it("tells a product with no Vercel project to deploy the file first", async () => {
    const { ctx, sent } = sellingRun();
    store.setProductVercel("acme", null);
    expect(await callTool(ctx, "POST /v1/sell-print", PRINT)).toBe(
      "Acme has no Vercel project yet: deploy it with the print file, which makes one, then list it.",
    );
    expect(sent).toEqual([]);
  });
});

const CATALOG_TEE = {
  brand: "Bella + Canvas",
  id: 71,
  is_discontinued: false,
  model: "3001",
  name: "Unisex Staple T-Shirt",
  placements: [{ placement: "front", technique: "dtg" }],
  techniques: [{ key: "dtg" }],
  type: "T-SHIRT",
};

/** Priya's run with the founder's keys, reading a catalog that answers `read`. */
const catalogRun = (read: CatalogRead, missing: Keys = {}) => {
  const run = sellingRun(missing);
  const queries: CatalogQuery[] = [];
  const ctx: RunContext = {
    ...run.ctx,
    printListing: {
      ...run.ctx.printListing,
      catalog: (query) => {
        queries.push(query);
        return Promise.resolve(read);
      },
    },
  };
  return { ...run, ctx, queries };
};

describe("printful_catalog", () => {
  it("lists a page of products, saying how to read the next", async () => {
    const { ctx, queries } = catalogRun({
      kind: "products",
      offset: 0,
      products: [CATALOG_TEE],
      total: 120,
    });
    expect(await callTool(ctx, "POST /v1/printful-catalog", {})).toBe(
      `Printful's catalog, from product 1 of 120 that ship to the US (id: name — techniques; discontinued ones left out). Pass "product":<id> for its placements and variants. Pass "offset":50 for the next page.\n71: Unisex Staple T-Shirt (Bella + Canvas 3001) — dtg`,
    );
    expect(queries).toEqual([{ offset: 0 }]);
  });

  it("gives a product's placements and variants as sell_print takes them", async () => {
    const { ctx, queries } = catalogRun({
      kind: "product",
      product: CATALOG_TEE,
      variants: [
        { id: 4012, label: "Black / S" },
        { id: 4013, label: "Black / M" },
      ],
    });
    expect(await callTool(ctx, "POST /v1/printful-catalog", { product: 71 })).toBe(
      "71: Unisex Staple T-Shirt\nPlacements, as sell_print's placement (technique): front (dtg)\nVariants, as sell_print's variantIds (id: colour / size):\n4012: Black / S\n4013: Black / M",
    );
    expect(queries).toEqual([{ product: 71 }]);
  });

  it("leaves the founder a Printful card with no token", async () => {
    const { asked, ctx, queries } = catalogRun({ kind: "refused" }, { printful: true });
    expect(await callTool(ctx, "POST /v1/printful-catalog", {})).toContain(
      "IdleBiz has no Printful token",
    );
    expect(queries).toEqual([]);
    expect(asked).toMatchObject([{ integration: "printful", type: "integration" }]);
  });

  it("asks for a new token once Printful turns the saved one away", async () => {
    const { asked, ctx } = catalogRun({ kind: "refused" });
    expect(await callTool(ctx, "POST /v1/printful-catalog", {})).toContain(
      "Printful turned IdleBiz's token away",
    );
    expect(asked).toMatchObject([{ integration: "printful", type: "integration" }]);
  });
});

describe("read_orders", () => {
  const paid = {
    collectedCents: 3599,
    email: "ada@example.com",
    livemode: true,
    paymentIntent: "pi_1",
    productId: "acme",
  };

  it("lists the product's orders newest first, with who to ship to and where each stands", async () => {
    const { ctx } = runAs("priya");
    store.recordListing({
      betId: null,
      costCents: 1820,
      createdAt: 1,
      id: "launch-tee",
      livemode: true,
      name: "Launch tee",
      paymentLink: { id: "plink_1", url: LISTED_URL },
      placements: [
        { fileUrl: LISTED_URL, placement: "front", sha256: DESIGN_SHA, technique: "dtg" },
      ],
      priceCents: 2800,
      productId: "acme",
      shippingCents: 799,
      variants: [{ id: 4013, label: "Black / M" }],
    });
    store.recordOrder({
      ...paid,
      costCents: 2410,
      createdAt: Date.UTC(2026, 8, 20),
      id: "order-ada",
      kind: "sale",
      listingId: "launch-tee",
      printfulStatus: "pending",
      quantity: 1,
      recipient: {
        address1: "1 Main St",
        address2: null,
        city: "Springfield",
        countryCode: "US",
        name: "Ada Buyer",
        phone: null,
        stateCode: "IL",
        zip: "62701",
      },
      sessionId: "cs_ada",
      stage: { kind: "confirmed", printfulId: 9001 },
      variant: { id: 4013, label: "Black / M" },
    });
    store.recordOrder({
      ...paid,
      createdAt: Date.UTC(2026, 8, 21),
      email: "bo@example.com",
      id: "order-bo",
      kind: "unreadable",
      listingId: "launch-tee",
      sessionId: "cs_bo",
      why: "Stripe's checkout carries no whole US shipping address",
    });
    store.recordOrder({
      ...paid,
      collectedCents: 900,
      createdAt: Date.UTC(2026, 8, 22),
      delivery: "Email the PDF at memos/acme.pdf",
      email: "cy@example.com",
      id: "order-cy",
      kind: "link",
      name: "Acme teardown",
      sessionId: "cs_cy",
    });

    expect(
      await callTool({ ...ctx, run: { ...ctx.run, productId: "acme" } }, "POST /v1/orders", {}),
    ).toBe(
      [
        "Acme's paid orders, newest first (3 of 3):",
        "- 2026-09-22 · Acme teardown · paid $9.00 · the founder delivers it: Email the PDF at memos/acme.pdf",
        "  cy@example.com",
        "- 2026-09-21 · Launch tee · paid $35.99 · not sent to Printful: Stripe's checkout carries no whole US shipping address; the founder handles it",
        "  bo@example.com",
        "- 2026-09-20 · Launch tee (Black / M) × 1 · paid $35.99 · at Printful (order 9001): pending",
        "  Ada Buyer, ada@example.com",
        "  1 Main St, Springfield, IL 62701, US",
      ].join("\n"),
    );
  });

  it("says when a product has sold nothing yet", async () => {
    const { ctx } = runAs("priya");
    expect(await callTool(ctx, "POST /v1/orders", { product: "acme" })).toBe(
      "Acme has no paid orders yet.",
    );
  });
});
