import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BadRequestError } from "@repo/domain/errors";
import type { JsonValue } from "@repo/domain/json";
import type { RunContext } from "./define";
import type { StripeAnswer } from "./fixtures";
import {
  BET,
  DESIGN_SHA,
  LISTED_URL,
  PAID_URL,
  PRO_LINK,
  TOKEN,
  VERCEL,
  callTool,
  replayingStripe,
  revenueBet,
  root,
  runAs,
} from "./fixtures";
import * as store from "../store/store";
import { callTool as outcomeOf } from "./index";
import { stripeLinkAccess, stripePaymentLink } from "../stripe-links";

const LINK = { amountUsd: 9, name: "Pro plan" };

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
    if (endpoint.startsWith("/v1/payment_links/")) {
      return Promise.resolve(Response.json({ active: false, id: "plink_pro" }));
    }
    return Promise.resolve(
      Response.json(
        endpoint === "/v1/prices" ? { id: "price_1" } : { id: "plink_pro", url: PAID_URL },
      ),
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
    checkoutAccess: () => Promise.resolve({ kind: "granted" }),
    createPaymentLink: stripePaymentLink,
    linkAccess: () => Promise.resolve({ kind: "granted" }),
    run: { ...run.ctx.run, productId: "acme" },
  };
  return { ...run, ctx, stripe };
};

const UNLOCK = "https://play.acme.dev/unlock";
const UNLOCK_ACTION = `payment link "Pro plan" at $9.00 on acme then send buyers to ${UNLOCK}`;

/** A charging run whose Acme serves production on acme-site.vercel.app and play.acme.dev, with the founder's Vercel token saved too. */
const landingRun = () => {
  const run = chargingRun(null);
  writeFileSync(
    path.join(root, "secrets.json"),
    JSON.stringify({ STRIPE_SECRET_KEY: "sk_live_founder", VERCEL_TOKEN: TOKEN }),
  );
  store.setProductVercel("acme", VERCEL);
  const hostsAsked: string[] = [];
  const ctx: RunContext = {
    ...run.ctx,
    productionHosts: (_binding, token) => {
      hostsAsked.push(token);
      return Promise.resolve({ hosts: ["acme-site.vercel.app", "play.acme.dev"], kind: "listed" });
    },
  };
  return { ...run, ctx, hostsAsked };
};

describe("create_payment_link", () => {
  it("holds the first call for the founder's sign-off, and asks Stripe nothing", async () => {
    const { ctx, asked, stripe } = chargingRun();
    const bet = revenueBet();
    const action = `payment link "Pro plan" at $9.00 on acme for bet ${bet.id}`;

    expect(await callTool(ctx, "create_payment_link", { ...LINK, bet: bet.id })).toBe(
      `Held for the founder's sign-off on "${action}". End your turn: the task resumes on their answer, and calling the tool again then runs it.`,
    );
    expect(asked).toEqual([{ command: action, rule: "payments", type: "approval" }]);
    expect(stripe).toEqual([]);
  });

  it("refuses a sign-off never asked for when the run already asked the founder something", async () => {
    const { ctx, asked, stripe } = chargingRun();
    await callTool(ctx, "ask_boss", { action: "Verify the email", instructions: "..." });

    const unsent = await outcomeOf(ctx, "create_payment_link", LINK);
    expect(unsent?.kind).toBe("refused");
    const said = unsent?.text;
    expect(said).toContain(`Held for the founder's sign-off on "payment link`);
    expect(said).toContain("The founder was not asked");
    expect(said).not.toContain("the task resumes on their answer");
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

    expect(await callTool(ctx, "create_payment_link", { ...LINK, bet: bet.id })).toBe(
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
    expect({ ...store.getChargeLink("plink_pro"), createdAt: 1 }).toEqual({
      ...PRO_LINK,
      betId: bet.id,
    });
    expect(await callTool(ctx, "create_payment_link", { ...LINK, bet: bet.id })).toContain(
      "Held for the founder's sign-off",
    );
    expect(stripe).toHaveLength(2);
  });

  it("keeps and switches off a link Stripe made while its product retired", async () => {
    const { ctx, stripe } = chargingRun();
    const side = store.createProduct({ description: "a side project", name: "Side" });
    store.grantApproval(ctx.run.taskId, `payment link "Pro plan" at $9.00 on ${side.id}`);
    const retiring: RunContext = {
      ...ctx,
      createPaymentLink: async (req) => {
        const made = await stripePaymentLink(req);
        store.killProduct(side.id, "dud", null);
        return made;
      },
    };

    const answer = await callTool(retiring, "create_payment_link", {
      ...LINK,
      product: side.id,
    });

    expect(stripe.map((s) => s.endpoint)).toEqual([
      "/v1/prices",
      "/v1/payment_links",
      "/v1/payment_links/plink_pro",
    ]);
    expect(store.getChargeLink("plink_pro")).toMatchObject({
      productId: side.id,
      state: { by: "idlebiz", kind: "switched-off" },
    });
    expect(answer).toContain(
      `Side was retired while Stripe made its payment link. Its link "Pro plan" ${PAID_URL} is switched off at Stripe `,
    );
  });

  it("gets back the link a timed-out create made when signed for again, rather than make a second", async () => {
    const { ctx } = chargingRun();
    const replays = new Map<string, Record<string, string>>();
    let links = 0;
    let timeouts = 1;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      const endpoint = new URL(url).pathname;
      const key = new Headers(init.headers).get("Idempotency-Key");
      const replay = key === null ? undefined : replays.get(key);
      if (replay !== undefined) {
        return Promise.resolve(Response.json(replay));
      }
      if (endpoint === "/v1/prices") {
        return Promise.resolve(Response.json({ id: "price_1" }));
      }
      links += 1;
      const link = { id: `plink_${links}`, url: `https://buy.stripe.com/${links}` };
      if (key !== null) {
        replays.set(key, link);
      }
      if (timeouts > 0) {
        timeouts -= 1;
        return Promise.reject(
          new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        );
      }
      return Promise.resolve(Response.json(link));
    });
    const call = () => {
      store.grantApproval(ctx.run.taskId, 'payment link "Pro plan" at $9.00 on acme');
      return callTool(ctx, "create_payment_link", LINK);
    };

    expect(await call()).toContain("Stripe made no payment link");
    expect(await call()).toContain("https://buy.stripe.com/1");
    expect(await call()).toContain("https://buy.stripe.com/1");

    expect(links).toBe(1);
    expect(store.paymentLinks().map((l) => l.link.id)).toEqual(["plink_1"]);
  });

  it("makes the link when signed for again after Stripe answered the create with a failure", async () => {
    const { ctx } = chargingRun();
    let failures = 1;
    replayingStripe((endpoint): StripeAnswer => {
      if (endpoint === "/v1/prices") {
        return { body: { id: "price_1" }, status: 200 };
      }
      if (failures > 0) {
        failures -= 1;
        return { body: { error: { message: "An unknown error occurred" } }, status: 500 };
      }
      return { body: { id: "plink_pro", url: PAID_URL }, status: 200 };
    });
    const call = () => {
      store.grantApproval(ctx.run.taskId, 'payment link "Pro plan" at $9.00 on acme');
      return callTool(ctx, "create_payment_link", LINK);
    };

    expect(await call()).toContain("Stripe made no payment link: An unknown error occurred");
    expect(await call()).toContain(PAID_URL);
    expect(store.paymentLinks().map((l) => l.link.id)).toEqual(["plink_pro"]);
  });

  it("says the link may stand on Stripe when Stripe took the create but answered in a shape IdleBiz does not read, and reports it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = chargingRun();
    replayingStripe((endpoint): StripeAnswer =>
      endpoint === "/v1/prices"
        ? { body: { id: "price_1" }, status: 200 }
        : { body: { id: "plink_pro", link: PAID_URL }, status: 200 },
    );
    store.grantApproval(ctx.run.taskId, 'payment link "Pro plan" at $9.00 on acme');

    const made = await outcomeOf(ctx, "create_payment_link", LINK);
    expect(made.kind).toBe("refused");
    expect(made.text).toContain("Stripe may have made the payment link");
    expect(logged).toHaveBeenCalledExactlyOnceWith("[Stripe payment link]", expect.any(z.ZodError));
    expect(store.paymentLinks()).toEqual([]);
  });

  it("makes a new link rather than record one Stripe replays that is switched off since", async () => {
    const replays = new Map<string, JsonValue>();
    const active = new Map<string, boolean>();
    const stripe = (url: string, init: RequestInit = {}) => {
      const { pathname } = new URL(url);
      const id = pathname.split("/").at(-1) ?? "";
      if (init.method !== "POST") {
        return Promise.resolve(Response.json({ active: active.get(id), id }));
      }
      const key = new Headers(init.headers).get("Idempotency-Key") ?? "";
      const replay = replays.get(key);
      if (replay !== undefined) {
        return Promise.resolve(
          Response.json(replay, { headers: { "Idempotent-Replayed": "true" } }),
        );
      }
      const n = active.size + 1;
      const made: JsonValue =
        pathname === "/v1/prices"
          ? { id: `price_${n}` }
          : { active: true, id: `plink_${n}`, url: `https://buy.stripe.com/${n}` };
      if (pathname === "/v1/payment_links") {
        active.set(`plink_${n}`, true);
      }
      replays.set(key, made);
      return Promise.resolve(Response.json(made));
    };
    const make = () => {
      const { ctx } = chargingRun();
      vi.stubGlobal("fetch", stripe);
      store.grantApproval(ctx.run.taskId, 'payment link "Pro plan" at $9.00 on acme');
      return callTool(ctx, "create_payment_link", LINK);
    };
    expect(await make()).toContain("https://buy.stripe.com/1");
    // the founder resets, which switches the link off, and founds Acme again
    active.set("plink_1", false);
    rmSync(root, { force: true, recursive: true });
    store.initStore();

    expect(await make()).toContain(
      'Created a payment link for "Pro plan" at $9.00 on Acme: https://buy.stripe.com/2',
    );
    expect(store.paymentLinks().map(({ link }) => [link.id, link.state.kind])).toEqual([
      ["plink_2", "selling"],
    ]);
  });

  it("tags the product alone when no bet is named, charging whole cents", async () => {
    const { ctx, stripe } = chargingRun();
    const side = store.createProduct({ description: "a side project", name: "Side" });
    store.grantApproval(ctx.run.taskId, `payment link "Pro plan" at $12.50 on ${side.id}`);

    const answer = await callTool(ctx, "create_payment_link", {
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
    store.grantApproval(
      ctx.run.taskId,
      'payment link "Pro plan" at $9.00 on acme delivering "Email the licence key from keys.txt"',
    );

    const answer = await callTool(ctx, "create_payment_link", {
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

  it("has the founder sign the delivery they owe each buyer, so another delivery is signed anew", async () => {
    const { ctx, asked, stripe } = chargingRun();
    store.grantApproval(ctx.run.taskId, 'payment link "Pro plan" at $9.00 on acme');

    const held = await callTool(ctx, "create_payment_link", {
      ...LINK,
      delivery: "Mail each buyer a signed print",
    });

    expect(held).toContain("Held for the founder's sign-off");
    expect(asked).toEqual([
      {
        command:
          'payment link "Pro plan" at $9.00 on acme delivering "Mail each buyer a signed print"',
        rule: "payments",
        type: "approval",
      },
    ]);
    expect(stripe).toEqual([]);
  });

  it("leaves a Stripe card, not a sign-off, for a delivery the key cannot read checkouts for", async () => {
    const run = chargingRun();
    const ctx: RunContext = {
      ...run.ctx,
      checkoutAccess: () =>
        Promise.resolve({
          kind: "refused",
          said: "The provided key does not have rak_checkout_session_read",
        }),
    };

    const answer = await callTool(ctx, "create_payment_link", {
      ...LINK,
      delivery: "Email the PDF",
    });

    expect(answer).toContain("Stripe won't let IdleBiz's key read checkouts");
    expect(run.asked).toMatchObject([{ integration: "stripe", type: "integration" }]);
    expect(run.stripe).toEqual([]);
  });

  it("leaves a Stripe card, and spends no sign-off, while Stripe turns the saved key away", async () => {
    const run = chargingRun("rk_live_rolledkey123");
    const action = 'payment link "Pro plan" at $9.00 on acme';
    store.grantApproval(run.ctx.run.taskId, action);
    const asked: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(new URL(url).pathname);
      return Promise.resolve(
        Response.json(
          { error: { message: "Expired API Key provided: rk_live_*****y123" } },
          { status: 401 },
        ),
      );
    });
    const ctx: RunContext = { ...run.ctx, linkAccess: stripeLinkAccess };

    expect(await callTool(ctx, "create_payment_link", LINK)).toContain(
      "Stripe won't let IdleBiz's key make payment links: the founder has a Stripe card waiting",
    );
    expect(asked).toEqual(["/v1/payment_links"]);
    expect(run.asked).toEqual([
      {
        integration: "stripe",
        productId: null,
        reason:
          "Stripe won't let IdleBiz's key make payment links, which charging through one needs (Expired API Key provided: rk_live_*****y123): in the Budget panel, paste over it a key whose restricted permissions include Write on Payment Links, Prices and Products, or your secret key",
        type: "integration",
      },
    ]);
    expect(store.consumeApproval(ctx.run.taskId, action)).toBe(true);
  });

  it("leaves a Stripe card when Stripe turns the key away from making the link after all", async () => {
    const { ctx, asked } = chargingRun();
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json(
          { error: { message: "The provided key does not have the required permissions" } },
          { status: 403 },
        ),
      ),
    );
    store.grantApproval(ctx.run.taskId, 'payment link "Pro plan" at $9.00 on acme');

    expect(await callTool(ctx, "create_payment_link", LINK)).toContain(
      "Stripe won't let IdleBiz's key make payment links: the founder has a Stripe card waiting",
    );
    expect(asked).toMatchObject([{ integration: "stripe", type: "integration" }]);
    expect(JSON.stringify(asked)).toContain(
      "(The provided key does not have the required permissions)",
    );
    expect(store.paymentLinks()).toEqual([]);
  });

  it("quotes the name in what the founder signs, so it cannot pose as the price", async () => {
    const { ctx, asked } = chargingRun();
    await callTool(ctx, "create_payment_link", { amountUsd: 500, name: 'Tip" at $1.00 on acme' });
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
      await expect(callTool(ctx, "create_payment_link", { amountUsd: 500, name })).rejects.toThrow(
        BadRequestError,
      );
      expect(asked).toEqual([]);
      expect(stripe).toEqual([]);
    },
  );

  it("leaves the founder a Stripe card, not a sign-off, while IdleBiz has no key", async () => {
    const { ctx, asked, stripe } = chargingRun(null);
    const answer = await callTool(ctx, "create_payment_link", LINK);
    expect(answer).toContain("a Stripe card waiting that takes them to the Budget panel");
    expect(answer).toContain("this task resumes automatically once the key is saved");
    expect(asked).toEqual([
      {
        integration: "stripe",
        productId: null,
        reason: 'to sell "Pro plan" at $9.00 through a payment link',
        type: "integration",
      },
    ]);
    expect(stripe).toEqual([]);
  });

  it("raises no card for a link it could not make anyway", async () => {
    const { ctx, asked } = chargingRun(null);
    expect(await callTool(ctx, "create_payment_link", { ...LINK, bet: "no-such-bet" })).toContain(
      "is not a revenue bet on acme",
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
      expect(await callTool(ctx, "create_payment_link", { ...LINK, bet: bet.id })).toBe(
        `"${bet.id}" is not a revenue bet on acme that is open or measuring — read_bets lists every live bet, what it counts and its product.`,
      );
    }
    expect(asked).toEqual([]);
    expect(stripe).toEqual([]);
  });

  it("still makes a signed link for a bet the lead measures while it waited, since that money counts", async () => {
    const { ctx, stripe } = chargingRun();
    const bet = revenueBet();
    store.grantApproval(
      ctx.run.taskId,
      `payment link "Pro plan" at $9.00 on acme for bet ${bet.id}`,
    );
    store.measureBet(bet.id, Date.now());

    expect(await callTool(ctx, "create_payment_link", { ...LINK, bet: bet.id })).toContain(
      "Created a payment link",
    );
    expect(stripe).not.toEqual([]);
  });

  it("says a test key's link takes no real money", async () => {
    const { ctx } = chargingRun("sk_test_founder");
    store.grantApproval(ctx.run.taskId, 'payment link "Pro plan" at $9.00 on acme');
    expect(await callTool(ctx, "create_payment_link", LINK)).toBe(
      `Created a payment link for "Pro plan" at $9.00 on Acme: ${PAID_URL} Nothing names a delivery, so a buyer gets only Stripe's receipt. Stripe is in test mode: the link takes no real money, and what it takes counts for nothing unless IdleBiz runs with IDLEBIZ_COUNT_TEST_MONEY=1.`,
    );
  });

  it("has the founder sign the page paying buyers land on, and asks Stripe nothing yet", async () => {
    const { ctx, asked, hostsAsked, stripe } = landingRun();
    store.grantApproval(ctx.run.taskId, 'payment link "Pro plan" at $9.00 on acme');

    expect(await callTool(ctx, "create_payment_link", { ...LINK, afterPaymentUrl: UNLOCK })).toBe(
      `Held for the founder's sign-off on "${UNLOCK_ACTION}". End your turn: the task resumes on their answer, and calling the tool again then runs it.`,
    );
    expect(asked).toEqual([{ command: UNLOCK_ACTION, rule: "payments", type: "approval" }]);
    expect(hostsAsked).toEqual([TOKEN]);
    expect(stripe).toEqual([]);
  });

  it.each([
    {
      page: UNLOCK,
      sent: "https://play.acme.dev/unlock?session_id={CHECKOUT_SESSION_ID}",
    },
    {
      page: "https://PLAY.acme.dev/unlock?level=2#top",
      sent: "https://play.acme.dev/unlock?level=2&session_id={CHECKOUT_SESSION_ID}#top",
    },
  ])(
    "once signed off, has Stripe send each buyer to $page with their checkout session",
    async ({ page, sent }) => {
      const { ctx, stripe } = landingRun();
      const signed = new URL(page).href;
      store.grantApproval(
        ctx.run.taskId,
        `payment link "Pro plan" at $9.00 on acme then send buyers to ${signed}`,
      );

      const answer = await callTool(ctx, "create_payment_link", {
        ...LINK,
        afterPaymentUrl: page,
      });

      expect(answer).toBe(
        `Created a payment link for "Pro plan" at $9.00 on Acme: ${PAID_URL} Each buyer who pays lands on ${signed} with a session_id naming their checkout session: unlock only what the product's server reads there as paid on this link, plink_pro.`,
      );
      expect(stripe[1]).toEqual({
        auth: "Bearer sk_live_founder",
        endpoint: "/v1/payment_links",
        form: {
          "after_completion[redirect][url]": sent,
          "after_completion[type]": "redirect",
          "line_items[0][price]": "price_1",
          "line_items[0][quantity]": "1",
          "metadata[product]": "acme",
          "payment_intent_data[metadata][product]": "acme",
        },
      });
    },
  );

  it.each([
    {
      page: "http://play.acme.dev/unlock",
      said: "http://play.acme.dev/unlock is not https: buyers who paid are sent only to an https page on the product's own domain.",
    },
    {
      page: "data:text/html,paid",
      said: "data:text/html,paid is not https",
    },
    {
      page: "https://me:pw@play.acme.dev/unlock",
      said: "carries a login: the page buyers land on has to be public",
    },
    {
      page: "https://play.acme.dev/unlock?session_id=cs_live_paid",
      said: "already has a session_id: IdleBiz adds it",
    },
    {
      page: "https://play.acme.dev:8443/unlock",
      said: "https://play.acme.dev:8443/unlock names port 8443: Vercel serves the product only on https's own port, so name the page without one.",
    },
    {
      page: "https://acme.example.com/unlock",
      said: "https://acme.example.com/unlock is not on Acme's production domains (acme-site.vercel.app, play.acme.dev): buyers who paid are sent only to a page the product itself serves, where its server checks their checkout.",
    },
  ])("refuses a landing page the product does not serve: $page", async ({ page, said }) => {
    const { ctx, asked, stripe } = landingRun();
    expect(
      await callTool(ctx, "create_payment_link", { ...LINK, afterPaymentUrl: page }),
    ).toContain(said);
    expect(asked).toEqual([]);
    expect(stripe).toEqual([]);
  });

  it("refuses a landing page that is no URL as the caller's error", async () => {
    const { ctx, stripe } = landingRun();
    await expect(
      callTool(ctx, "create_payment_link", { ...LINK, afterPaymentUrl: "/unlock" }),
    ).rejects.toThrow(BadRequestError);
    expect(stripe).toEqual([]);
  });

  it("tells a product with no Vercel project to deploy its landing page first", async () => {
    const { ctx, hostsAsked, stripe } = landingRun();
    store.setProductVercel("acme", null);
    expect(await callTool(ctx, "create_payment_link", { ...LINK, afterPaymentUrl: UNLOCK })).toBe(
      "Acme has no Vercel project yet: deploy the page buyers land on, which makes one, then make the link.",
    );
    expect(hostsAsked).toEqual([]);
    expect(stripe).toEqual([]);
  });

  it("leaves a Vercel card while it cannot check where the product is served", async () => {
    const { ctx, asked, hostsAsked, stripe } = landingRun();
    writeFileSync(
      path.join(root, "secrets.json"),
      JSON.stringify({ STRIPE_SECRET_KEY: "sk_live_founder" }),
    );
    expect(
      await callTool(ctx, "create_payment_link", { ...LINK, afterPaymentUrl: UNLOCK }),
    ).toContain("Vercel is not connected");
    expect(asked).toEqual([
      {
        integration: "vercel",
        productId: "acme",
        reason: "to check where Acme sends buyers who paid",
        type: "integration",
      },
    ]);
    expect(hostsAsked).toEqual([]);
    expect(stripe).toEqual([]);
  });

  it("signs the bet, the delivery and the landing page in that order, and sends Stripe all three", async () => {
    const { ctx, asked, stripe } = landingRun();
    const bet = revenueBet();
    const action = `payment link "Pro plan" at $9.00 on acme for bet ${bet.id} delivering "A thank-you email" then send buyers to ${UNLOCK}`;
    const call = { ...LINK, afterPaymentUrl: UNLOCK, bet: bet.id, delivery: "A thank-you email" };

    expect(await callTool(ctx, "create_payment_link", call)).toContain(
      `Held for the founder's sign-off on "${action}".`,
    );
    expect(asked).toEqual([{ command: action, rule: "payments", type: "approval" }]);
    expect(stripe).toEqual([]);

    store.grantApproval(ctx.run.taskId, action);
    expect(await callTool(ctx, "create_payment_link", call)).toContain(
      "The founder gets a card for each paid checkout, with the buyer's email and your delivery.",
    );
    expect(stripe[1]?.form).toMatchObject({
      "after_completion[redirect][url]": `${UNLOCK}?session_id={CHECKOUT_SESSION_ID}`,
      "after_completion[type]": "redirect",
      "metadata[bet]": bet.id,
      "metadata[delivery]": "A thank-you email",
    });
  });

  it("leaves a Vercel card when Vercel turns the token away while checking the landing page", async () => {
    const { ctx, asked, stripe } = landingRun();
    const refused: RunContext = {
      ...ctx,
      productionHosts: () => Promise.resolve({ kind: "refused" }),
    };

    expect(
      await callTool(refused, "create_payment_link", { ...LINK, afterPaymentUrl: UNLOCK }),
    ).toContain("Vercel turned IdleBiz's token away");
    expect(asked).toEqual([
      {
        integration: "vercel",
        productId: "acme",
        reason: "Vercel turned IdleBiz's token away while checking Acme's domains",
        type: "integration",
      },
    ]);
    expect(stripe).toEqual([]);
  });

  it("asks again later when Vercel cannot say where the landing page is served", async () => {
    const { ctx, asked, stripe } = landingRun();
    const unreachable: RunContext = {
      ...ctx,
      productionHosts: () => Promise.resolve({ kind: "unreachable", reason: "timed out" }),
    };

    expect(
      await callTool(unreachable, "create_payment_link", { ...LINK, afterPaymentUrl: UNLOCK }),
    ).toBe("Vercel could not say where Acme is served (timed out); try again.");
    expect(asked).toEqual([]);
    expect(stripe).toEqual([]);
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
    expect(await callTool(ctx, "create_payment_link", LINK)).toBe(
      "Stripe made no payment link: Your account cannot currently make live charges.",
    );
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
      paymentLink: { id: "plink_1", state: { kind: "selling" }, url: LISTED_URL },
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
      await callTool({ ...ctx, run: { ...ctx.run, productId: "acme" } }, "read_orders", {}),
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
    expect(await callTool(ctx, "read_orders", { product: "acme" })).toBe(
      "Acme has no paid orders yet.",
    );
  });

  it("says which of a retired product's links no longer sell", async () => {
    const { ctx } = runAs("priya");
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const sideLink = { ...PRO_LINK, productId: side.id };
    store.recordChargeLink(sideLink);
    store.recordOrder({
      ...paid,
      collectedCents: 900,
      createdAt: Date.UTC(2026, 8, 22),
      delivery: null,
      id: "order-cy",
      kind: "link",
      name: "Pro plan",
      productId: side.id,
      sessionId: "cs_cy",
    });
    store.killProduct(side.id, "dud", null);
    store.setLinkState(
      { kind: "charge", link: sideLink },
      {
        at: Date.UTC(2026, 8, 23),
        by: "idlebiz",
        kind: "switched-off",
      },
    );

    expect(await callTool(ctx, "read_orders", { product: side.id })).toBe(
      [
        `${side.id}'s paid orders, newest first (1 of 1):`,
        "- 2026-09-22 · Pro plan · paid $9.00 · paid through a payment link that names no delivery",
        "  ada@example.com",
        "Its payment links:",
        `- "Pro plan" ${PAID_URL} is switched off at Stripe 2026-09-23, when its product retired, so it takes no new money`,
      ].join("\n"),
    );
  });

  it("says where a retired product's links stand though it sold nothing, the founder's own switch-off too", async () => {
    const { ctx } = runAs("priya");
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const sideLink = { ...PRO_LINK, productId: side.id };
    store.recordChargeLink(sideLink);
    store.recordChargeLink({
      ...PRO_LINK,
      id: "plink_next",
      name: "Next plan",
      productId: side.id,
      url: "https://buy.stripe.com/next",
    });
    store.killProduct(side.id, "dud", null);
    store.setLinkState(
      { kind: "charge", link: sideLink },
      {
        at: Date.UTC(2026, 8, 23),
        by: "founder",
        kind: "switched-off",
      },
    );

    expect(await callTool(ctx, "read_orders", { product: side.id })).toBe(
      [
        `${side.id} has no paid orders yet.`,
        "Its payment links:",
        `- "Pro plan" ${PAID_URL} is switched off by hand in Stripe's dashboard 2026-09-23, the founder says, so it takes no new money`,
        '- "Next plan" https://buy.stripe.com/next is not switched off yet: IdleBiz switches it off at Stripe as soon as it can',
      ].join("\n"),
    );
  });
});
