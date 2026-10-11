import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@repo/domain/activity";
import { BadRequestError } from "@repo/domain/errors";
import { BET, PAID_URL, PRO_LINK, callTool, openBet, root, runAs } from "./fixtures";
import * as store from "../store/store";
import { fetchRealMetrics } from "../metrics";
import { activityEvents } from "../activity";

describe("portfolio tools", () => {
  it("opens a bet for the lead and says how it is counted", async () => {
    const { ctx } = runAs("mae");
    const answer = await callTool(ctx, "open_bet", BET);
    const [bet] = store.listBets();
    expect(bet?.claim).toEqual({ landingPath: `/b/${bet?.id}`, metric: "users" });
    expect(answer).toContain(`/b/${bet?.id}`);
  });

  it("opens a revenue bet counted by the money tagged with it", async () => {
    const { ctx } = runAs("mae");
    const answer = await callTool(ctx, "open_bet", { ...BET, metric: "revenue" });
    const [bet] = store.listBets();
    expect(bet?.claim).toEqual({ metric: "revenue" });
    expect(answer).toContain(`metadata[bet]=${bet?.id}`);
  });

  it("turns a product or a bet past the portfolio's caps away as an answer, not a fault", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = runAs("mae");
    for (const name of ["Two", "Three", "Four", "Five"]) {
      await callTool(ctx, "create_product", { description: name, name });
    }
    expect(await callTool(ctx, "create_product", { description: "x", name: "Six" })).toBe(
      "The company already runs 5 products; kill_product one before starting another.",
    );
    for (const title of ["One", "Two", "Three"]) {
      await callTool(ctx, "open_bet", { ...BET, product: "acme", title });
    }
    expect(await callTool(ctx, "open_bet", { ...BET, product: "acme" })).toBe(
      "Acme already carries 3 live bets; wait for a verdict or kill one first.",
    );
    expect(store.listProducts()).toHaveLength(5);
    expect(store.listBets()).toHaveLength(3);
    expect(logged).not.toHaveBeenCalled();
  });

  it("starts no clock over a number nothing could read, and starts it once a source can", async () => {
    const { ctx } = runAs("mae");
    const visits = await openBet(ctx);
    await callTool(ctx, "open_bet", { ...BET, metric: "revenue", title: "Paid tier" });
    const money = store.listBets().find((b) => b.claim.metric === "revenue");
    if (!money) {
      throw new Error("no revenue bet opened");
    }
    const measure = (slug: string) => callTool(ctx, "measure_bet", { slug });

    expect(await measure(money.id)).toBe(
      'No source reads revenue yet — request_integration "stripe" for the founder to add the Stripe key IdleBiz charges with in the Budget panel. Then measure_bet again.',
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
    await callTool(ctx, "open_bet", { ...BET, metric: "revenue", title: "Paid tier" });
    const [money] = store.listBets();
    if (!money) {
      throw new Error("no revenue bet opened");
    }
    const measure = () => callTool(ctx, "measure_bet", { slug: money.id });
    const secrets = path.join(root, "secrets.json");

    writeFileSync(secrets, '{"STRIPE_SECRET_KEY":"sk_test_1"}');
    expect(await measure()).toContain("Stripe is in test mode — no charge counts");
    expect(store.getBet(money.id)?.state.kind).toBe("open");

    writeFileSync(secrets, '{"STRIPE_SECRET_KEY":"sk_live_1"}');
    expect(await measure()).toContain("is measuring");
  });

  it("kills a revenue bet a test key read as unmeasured, so nothing learns from it", async () => {
    const { ctx } = runAs("mae");
    await callTool(ctx, "open_bet", { ...BET, metric: "revenue", title: "Paid tier" });
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

    const snap = await fetchRealMetrics("sk_test_1", store.listProducts(), store.listBets());
    for (const [betId, { reading, at }] of snap.betReadings) {
      store.setBetReading(betId, reading, at);
    }
    await callTool(ctx, "kill_bet", {
      reason: "no live Stripe to count it",
      slug: money.id,
    });

    expect(store.getBet(money.id)?.state).toMatchObject({ kind: "killed", moved: null });
  });

  it("refuses a kill reason too long for a line in the room", async () => {
    const { ctx } = runAs("mae");
    const bet = await openBet(ctx);
    const kill = (reason: string) => callTool(ctx, "kill_bet", { reason, slug: bet.id });
    await expect(kill("x".repeat(201))).rejects.toThrow(BadRequestError);
    expect(store.getBet(bet.id)?.state.kind).toBe("open");
    expect(await kill("x".repeat(200))).toContain("Killed");
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
      await callTool(ctx, "message_team", { text: "on it" });
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
      await callTool(ctx, "open_bet", { ...BET, hypothesis });
      await callTool(ctx, "message_team", { text: "m".repeat(500) });
    } finally {
      activityEvents.off("activity", listen);
    }
    const news = `🎲 New bet: ${BET.title} — ${hypothesis}`;
    expect(store.recentTeamMessages().map(({ text }) => text)).toEqual([news, "m".repeat(400)]);
    expect(heard).toEqual([news.slice(0, 400), "m".repeat(400)]);
  });
});

describe("name_product", () => {
  it("names the run's product for the lead, and tells the room and the feed", async () => {
    const { ctx } = runAs("mae");
    const [first] = store.listProducts();
    const id = first?.id ?? "";
    const heard: ActivityEvent[] = [];
    const listen = (e: ActivityEvent): void => {
      heard.push(e);
    };
    activityEvents.on("activity", listen);
    let answer: string | null = null;
    try {
      answer = await callTool({ ...ctx, run: { ...ctx.run, productId: id } }, "name_product", {
        description: "Invoices that chase themselves.",
        name: "Ledgerly",
      });
    } finally {
      activityEvents.off("activity", listen);
    }
    expect(answer).toBe(`${id} is now "Ledgerly": Invoices that chase themselves.`);
    expect(store.getProduct(id)?.name).toBe("Ledgerly");
    expect(store.recentTeamMessages().map(({ from, text }) => ({ from, text }))).toEqual([
      {
        from: { kind: "office" },
        text: "🏷 Mae named the product: Ledgerly — Invoices that chase themselves.",
      },
    ]);
    expect(heard.find((e) => e.kind === "product.named")).toMatchObject({
      employeeId: "mae",
      message: "Ledgerly",
      payload: { productId: id },
    });
  });

  it("names the product it is given, and answers a store refusal as the sentence to read", async () => {
    const { ctx } = runAs("mae");
    const gadget = store.createProduct({ description: "x", name: "Gadget" });
    const draft = { description: "A thing.", name: "Widget" };
    await callTool(ctx, "name_product", { ...draft, product: gadget.id });
    expect(store.getProduct(gadget.id)?.name).toBe("Widget");
    expect(await callTool(ctx, "name_product", { ...draft, product: "nope" })).toContain(
      'No product "nope" here',
    );
  });

  it("turns anyone but the lead away", async () => {
    const { ctx } = runAs("priya");
    const before = store.listProducts()[0]?.name;
    expect(await callTool(ctx, "name_product", { description: "x", name: "Mine" })).toContain(
      "Only the team lead names a product",
    );
    expect(store.listProducts()[0]?.name).toBe(before);
  });
});

describe("kill_product", () => {
  it("retires the product and says which of its payment links Stripe switched off", async () => {
    writeFileSync(
      path.join(root, "secrets.json"),
      JSON.stringify({ STRIPE_SECRET_KEY: "sk_live_founder" }),
    );
    const { ctx } = runAs("mae");
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    store.recordChargeLink({ ...PRO_LINK, productId: side.id });
    store.recordChargeLink({
      ...PRO_LINK,
      id: "plink_gone",
      name: "Old plan",
      productId: side.id,
      url: "https://buy.stripe.com/gone",
    });
    vi.stubGlobal("fetch", (url: string) =>
      Promise.resolve(
        url.endsWith("/plink_gone")
          ? Response.json({ error: { message: "No such payment_link" } }, { status: 404 })
          : Response.json({ active: false, id: PRO_LINK.id }),
      ),
    );

    const answer = await callTool(ctx, "kill_product", { reason: "dud", slug: side.id });

    expect(store.getProduct(side.id)).toBeNull();
    expect(answer).toContain(
      `Its payment links: "Pro plan" ${PAID_URL} is switched off at Stripe `,
    );
    expect(answer).toContain(
      '"Old plan" https://buy.stripe.com/gone is still on at Stripe, which would not switch it off (No such payment_link): the founder switches it off by hand. Each order already paid still ships, and still counts.',
    );
  });
});
