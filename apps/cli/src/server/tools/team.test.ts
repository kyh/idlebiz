import { describe, expect, it, vi } from "vitest";
import type { TaskOrigin } from "@repo/domain/domain";
import type { RunContext } from "./define";
import { hire } from "../test-support/save";
import { BET, HANDOFF, callTool, openBet, runAs } from "./fixtures";
import * as store from "../store/store";

describe("team tools", () => {
  it("turns a hire away at the seat cap as an answer, not a fault", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    store.setMaxAgents(2);
    expect(await callTool(ctx, "hire", { role: "engineer", title: "Engineer" })).toContain(
      "Couldn't hire: the office is at its 2-seat cap",
    );
    expect(store.listEmployees()).toHaveLength(2);
    expect(logged).not.toHaveBeenCalled();
  });

  it.each([
    { cap: 40, field: "name" },
    { cap: 60, field: "title" },
    { cap: 600, field: "persona" },
  ])("refuses a hire whose $field is too long for every brief", async ({ cap, field }) => {
    const { ctx } = runAs("mae");
    const newHire = { name: "Mara", persona: "ships", role: "designer", title: "Designer" };
    const hireWith = (text: string) => callTool(ctx, "hire", { ...newHire, [field]: text });
    await expect(hireWith("x".repeat(cap + 1))).rejects.toThrow(`at ${field}`);
    expect(store.listEmployees()).toHaveLength(2);
    expect(await hireWith("x".repeat(cap))).toContain("Hired");
  });

  it("refuses a delegated title too long for the lead's brief", async () => {
    const { ctx } = runAs("mae");
    const delegate = (title: string) => callTool(ctx, "delegate", { ...HANDOFF, title });
    await expect(delegate("x".repeat(81))).rejects.toThrow("at title");
    expect(store.listOpenTasks()).toEqual([]);
    expect(await delegate("x".repeat(80))).toContain("Delegated");
  });

  it("hands the founder an action, and says when a second ask of the run went nowhere", async () => {
    const { ctx, asked } = runAs("priya");
    const card = await callTool(ctx, "ask_boss", {
      action: "Post the launch thread",
      instructions: "Post it on r/SideProject and send me its URL.",
    });
    const second = await callTool(ctx, "ask_boss", { question: "Ship it?" });
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
    await callTool(ctx, "ask_boss", {
      action: "Buy acme.dev",
      draft,
      instructions: "...",
    });
    expect(asked).toMatchObject([{ draft: null, type: "action" }]);
  });

  it("delegates to a teammate by role, against the run's bet", async () => {
    const { ctx, assigned } = runAs("mae");
    await callTool(ctx, "open_bet", BET);
    const [bet] = store.listBets();
    const working = { ...ctx, run: { ...ctx.run, betId: bet?.id ?? null } };
    const answer = await callTool(working, "delegate", {
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

  it("fans same-role work out across the teammates who have the least of it", async () => {
    const { ctx } = runAs("mae", [hire("Sam"), hire("Ana")]);
    for (const title of ["Page A", "Page B", "Page C", "Page D"]) {
      await callTool(ctx, "delegate", { ...HANDOFF, title });
    }
    const holders = new Map(store.listOpenTasks().map((t) => [t.title, t.assigneeId]));
    expect(["Page A", "Page B", "Page C", "Page D"].map((t) => holders.get(t))).toEqual([
      "priya",
      "sam",
      "ana",
      "priya",
    ]);
  });

  it("delegates past a teammate whose runner cannot start the work", async () => {
    const { ctx } = runAs("mae", [hire("Ana", "Engineer", "codex")]);
    const resting: RunContext = {
      ...ctx,
      driver: {
        ...ctx.driver,
        restingRunner: (r) => (r === "claude" ? Date.now() + 60_000 : null),
      },
    };
    expect(await callTool(resting, "delegate", HANDOFF)).toContain("to Ana");
    const signedOut: RunContext = {
      ...ctx,
      driver: { ...ctx.driver, signedIn: (r) => r !== "claude" },
    };
    expect(await callTool(signedOut, "delegate", HANDOFF)).toContain("to Ana");
    const nobody: RunContext = { ...ctx, driver: { ...ctx.driver, signedIn: () => false } };
    expect(await callTool(nobody, "delegate", HANDOFF)).toContain("to Priya");
  });

  it("refuses work a bet's runs in flight would already spend", async () => {
    const { ctx } = runAs("mae");
    const bet = await openBet(ctx);
    store.recordBetSpend(bet.id, 2);
    const named = { ...HANDOFF, bet: bet.id };
    expect(await callTool(ctx, "delegate", named)).toContain("Delegated");
    expect(await callTool(ctx, "delegate", named)).toContain(
      "no room for another run: $2.00 of $3.00 spent and 1 in flight",
    );
    expect(store.listOpenTasks()).toHaveLength(1);
  });

  it("gives a bet that stopped taking work nothing more, even from its own run", async () => {
    const { ctx } = runAs("mae");
    const bet = await openBet(ctx);
    const settling = { ...ctx, run: { ...ctx.run, betId: bet.id, productId: bet.productId } };
    store.recordBetSpend(bet.id, 3);
    expect(await callTool(settling, "delegate", HANDOFF)).toContain("is spent out");
    store.measureBet(bet.id, 0);
    expect(await callTool(settling, "delegate", HANDOFF)).toContain("its clock is running");
    expect(store.listOpenTasks()).toEqual([]);
  });

  it("needs a bet named to put a bet's run to work on another product", async () => {
    const { ctx } = runAs("mae");
    const bet = await openBet(ctx);
    const side = store.createProduct({ description: "a side project", name: "Side" });
    const working = { ...ctx, run: { ...ctx.run, betId: bet.id } };
    const elsewhere = { ...HANDOFF, product: side.id };
    expect(await callTool(working, "delegate", elsewhere)).toContain(`Name a bet on ${side.id}`);
    expect(await callTool(ctx, "delegate", elsewhere)).toContain("Delegated");
    expect(store.listOpenTasks()).toMatchObject([{ betId: null, productId: side.id }]);
  });

  it("makes a proposal delegate against the bet it opened, never unfunded", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    const proposing: RunContext = { ...ctx, run: { ...ctx.run, origin: "propose" } };
    expect(await callTool(proposing, "delegate", HANDOFF)).toContain("open_bet first");
    expect(logged).not.toHaveBeenCalled();
    expect(store.listOpenTasks()).toEqual([]);
    const bet = await openBet(proposing);
    const named = { ...HANDOFF, bet: bet.id };
    expect(await callTool(proposing, "delegate", named)).toContain("Delegated");
    expect(store.listOpenTasks()).toMatchObject([{ betId: bet.id, origin: "delegated" }]);
  });

  it.each<TaskOrigin>(["founder", "routine", "delegated"])(
    "lets a %s run delegate work no bet pays for",
    async (origin) => {
      const { ctx } = runAs("mae");
      const unfunded: RunContext = { ...ctx, run: { ...ctx.run, origin } };
      expect(await callTool(unfunded, "delegate", HANDOFF)).toContain("Delegated");
      expect(store.listOpenTasks()).toMatchObject([{ betId: null, origin: "delegated" }]);
    },
  );

  it("tells the lead which of a released teammate's open work is now theirs, and what was dropped", async () => {
    const { ctx } = runAs("mae");
    await callTool(ctx, "delegate", HANDOFF);
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
    const answer = await callTool(ctx, "release", { slug: "priya" });
    expect(answer).toContain("Their open work is yours now: 1 task,");
    expect(answer).toContain("Dropped 1 task of theirs");
    expect(store.openTasksFor("mae")).toMatchObject([{ id: ask.id }]);
  });

  it("names no inherited work when the teammate left none", async () => {
    const { ctx } = runAs("mae");
    const answer = await callTool(ctx, "release", { slug: "priya" });
    expect(answer).not.toContain("open work");
    expect(answer).toContain("Released Priya.");
  });
});
