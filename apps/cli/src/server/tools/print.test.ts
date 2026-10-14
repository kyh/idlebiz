import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CatalogQuery, CatalogRead } from "../printful";
import type { RunContext } from "./define";
import type { StripeAnswer } from "./fixtures";
import {
  DESIGN,
  DESIGN_SHA,
  LISTED_URL,
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
import { readPrintFile } from "../print-listing";
import { printfulCatalog, printfulQuote } from "../printful";
import { stripeListingAccess, stripeShippedLink } from "../stripe-links";
import { productionHosts } from "../vercel";

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
const PRINT_ACTION = `sell "Launch tee" (variants 4012, 4013) printing front (dtg) https://acme-site.vercel.app/print/tee-1.png sha256:${DESIGN_SHA} at $28.00 via Printful on acme`;

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

/** Stripe's answer to a key reading checkouts, charges or shipping rates, as the key's grants have it. */
const stripeRead = (
  pathname: string,
  grants: { charges: number; checkouts: number; shippingRates: number },
) =>
  listAnswer(
    new Map([
      ["/v1/checkout/sessions", grants.checkouts],
      ["/v1/charges", grants.charges],
    ]).get(pathname) ?? grants.shippingRates,
  );

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
  charges = 200,
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
      return Promise.resolve(stripeRead(pathname, { charges, checkouts, shippingRates }));
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
    secrets.set("PRINTFUL_TOKEN", "pf_founder_token");
    writeFileSync(
      path.join(root, "printful-store.json"),
      JSON.stringify({ id: 42, name: "Acme Prints" }),
    );
  }
  writeFileSync(path.join(root, "secrets.json"), JSON.stringify(Object.fromEntries(secrets)));
  const run = runAs("priya");
  store.setProductVercel("acme", VERCEL);
  const sent = fakeSellers(sellers);
  const ctx: RunContext = {
    ...run.ctx,
    createPrintLink: stripeShippedLink,
    listingAccess: stripeListingAccess,
    printCatalog: printfulCatalog,
    productionHosts,
    quotePrint: printfulQuote,
    readPrintFile,
    run: { ...run.ctx.run, productId: "acme" },
  };
  return { ...run, ctx, sent };
};

const outward = (sent: readonly Sent[]) => sent.filter((s) => s.method === "POST");

describe("sell_print", () => {
  it("prices it with Printful, then holds it for the founder's sign-off before Stripe is asked", async () => {
    const { ctx, asked, sent } = sellingRun();

    expect(await callTool(ctx, "sell_print", PRINT)).toBe(
      `Held for the founder's sign-off on "${PRINT_ACTION}". End your turn: the task resumes on their answer, and calling the tool again then runs it.`,
    );
    expect(asked).toEqual([{ command: PRINT_ACTION, rule: "payments", type: "approval" }]);
    expect(outward(sent).map((s) => s.host)).not.toContain("api.stripe.com");
    expect(outward(sent)).toHaveLength(10);
    expect(
      sent.filter((s) => s.host === "api.stripe.com" && s.method === "GET").map((s) => s.path),
    ).toEqual(["/v1/shipping_rates", "/v1/checkout/sessions", "/v1/charges"]);
  });

  it("once signed off, lists it on a US-only card-only link at Printful's shipping, tagged and saved", async () => {
    const { ctx, sent } = sellingRun();
    const bet = revenueBet();
    const action = `${PRINT_ACTION} for bet ${bet.id}`;
    store.grantApproval(ctx.run.taskId, action);

    const answer = await callTool(ctx, "sell_print", { ...PRINT, bet: bet.id });

    expect(answer).toBe(
      `Listed "Launch tee" on Acme at $28.00 plus $7.99 shipping, US addresses only: ${LISTED_URL}\nPrintful charges up to $18.20 to print and ship each one to the US addresses IdleBiz priced it for; a buyer where tax runs higher costs more, and an order that would cost Printful more than it took waits on the founder. Each paid order goes to Printful on its own; read_orders shows them. Stripe is in test mode: the link takes no real money, and what it takes counts for nothing unless IdleBiz runs with IDLEBIZ_COUNT_TEST_MONEY=1.`,
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
          "payment_method_types[0]": "card",
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
      paymentLink: { id: "plink_1", state: { kind: "selling" }, url: LISTED_URL },
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
    expect(await callTool(ctx, "sell_print", { ...PRINT, bet: bet.id })).toContain(
      "Held for the founder's sign-off",
    );
  });

  it("gives one variant no choice on the payment page", async () => {
    const { ctx, sent } = sellingRun();
    store.grantApproval(
      ctx.run.taskId,
      PRINT_ACTION.replace("variants 4012, 4013", "variants 4012"),
    );

    await callTool(ctx, "sell_print", { ...PRINT, variantIds: [4012] });

    const link = sent.find((s) => s.path === "/v1/payment_links");
    expect(Object.keys(link?.form ?? {}).filter((k) => k.startsWith("custom_fields"))).toEqual([]);
    expect(link?.form).not.toHaveProperty("metadata[bet]");
  });

  it.each([11.35, 11.36])(
    "refuses $%s, a price that loses money, naming the lowest that does not, and asks nobody",
    async (priceUsd) => {
      const { ctx, asked, sent } = sellingRun();

      // (1820 + 30) / 0.956 = 1935.1…, less the $7.99 the buyer pays for shipping
      expect(await callTool(ctx, "sell_print", { ...PRINT, priceUsd })).toBe(
        `$${priceUsd} would lose money on every sale: Printful charges up to $18.20 to print one sold at that price and ship it to the US addresses IdleBiz prices it for, the buyer pays $7.99 of that as shipping, and Stripe keeps up to 4.4% + $0.30. Every price under $11.37 loses money: price it above that, with the margin the bet needs.`,
      );
      expect(asked).toEqual([]);
      expect(sent.map((s) => s.host)).not.toContain("api.stripe.com");
    },
  );

  it("takes a price exactly at the floor to the founder", async () => {
    const { ctx, asked } = sellingRun();
    await callTool(ctx, "sell_print", { ...PRINT, priceUsd: 11.37 });
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
        PRINTFUL_TOKEN: "pf_founder_token",
        STRIPE_SECRET_KEY: "rk_live_founder",
        VERCEL_TOKEN: TOKEN,
      }),
    );
    fakeSellers();
    store.grantApproval(ctx.run.taskId, PRINT_ACTION);

    const answer = await callTool(ctx, "sell_print", PRINT);

    expect(answer).toContain(`Listed "Launch tee" on Acme at $28.00`);
    expect(answer).not.toContain("test mode");
    expect(store.listListings()).toMatchObject([{ id: "launch-tee", livemode: true }]);
  });

  it.each([
    { grants: { shippingRates: 403 }, why: "make shipping rates" },
    { grants: { checkouts: 403 }, why: "read the checkouts that find each paid order" },
    { grants: { charges: 403 }, why: "read the charges that show a paid order still stands" },
  ])(
    "asks the founder to fix a Stripe key that cannot $why before they sign",
    async ({ grants }) => {
      const { ctx, asked, sent } = sellingRun({}, grants);

      expect(await callTool(ctx, "sell_print", PRINT)).toContain(
        "Stripe won't let IdleBiz's key make shipping rates or read checkouts and charges: the founder has a Stripe card waiting",
      );
      expect(asked).toMatchObject([{ integration: "stripe", type: "integration" }]);
      expect(outward(sent).map((s) => s.host)).not.toContain("api.stripe.com");
    },
  );

  it("asks again once the design behind the signed URL has changed", async () => {
    const { ctx, asked, sent } = sellingRun();
    store.grantApproval(ctx.run.taskId, PRINT_ACTION.replace(DESIGN_SHA, "0".repeat(64)));

    expect(await callTool(ctx, "sell_print", PRINT)).toContain("Held for the founder's sign-off");
    expect(asked).toEqual([{ command: PRINT_ACTION, rule: "payments", type: "approval" }]);
    expect(outward(sent).map((s) => s.host)).not.toContain("api.stripe.com");
  });

  it("keeps both of two namesakes listed at once, each under an id of its own", async () => {
    const { ctx } = sellingRun();
    const other = { ...ctx, run: { ...ctx.run, taskId: `${ctx.run.taskId}-other` } };
    for (const { run } of [ctx, other]) {
      store.grantApproval(run.taskId, PRINT_ACTION);
    }

    const answers = await Promise.all(
      [ctx, other].map((run) => callTool(run, "sell_print", PRINT)),
    );

    for (const answer of answers) {
      expect(answer).toContain('Listed "Launch tee" on Acme');
    }
    expect(store.listListings().map((l) => l.id)).toEqual(["launch-tee", "launch-tee-2"]);
  });

  it("sends Stripe the same keys when a listing is tried again, so nothing is made twice", async () => {
    const { ctx } = sellingRun();
    const keysOf = async () => {
      const sent = fakeSellers({ linkTimesOut: true });
      store.grantApproval(ctx.run.taskId, PRINT_ACTION);
      expect(await callTool(ctx, "sell_print", PRINT)).toContain("Stripe made no payment link");
      return outward(sent)
        .filter((s) => s.host === "api.stripe.com")
        .map((s) => s.idempotencyKey);
    };

    const first = await keysOf();
    expect(first).toHaveLength(3);
    expect(await keysOf()).toEqual(first);
    expect(store.listListings()).toEqual([]);
  });

  it("lists it when signed for again after Stripe answered the link's create with a failure", async () => {
    const { ctx } = sellingRun();
    const sellers = globalThis.fetch;
    let failures = 1;
    replayingStripe((endpoint): StripeAnswer => {
      if (endpoint !== "/v1/payment_links") {
        return { body: { id: endpoint === "/v1/prices" ? "price_1" : "shr_1" }, status: 200 };
      }
      if (failures > 0) {
        failures -= 1;
        return { body: { error: { message: "An unknown error occurred" } }, status: 500 };
      }
      return { body: { id: "plink_1", url: LISTED_URL }, status: 200 };
    }, sellers);
    const call = () => {
      store.grantApproval(ctx.run.taskId, PRINT_ACTION);
      return callTool(ctx, "sell_print", PRINT);
    };

    expect(await call()).toContain("Stripe made no payment link: An unknown error occurred");
    expect(await call()).toContain(LISTED_URL);
    expect(store.listListings().map((l) => l.paymentLink.id)).toEqual(["plink_1"]);
  });

  it("lists nothing, saying the link may stand on Stripe, when Stripe answered the link's create in a shape IdleBiz does not read", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = sellingRun();
    const sellers = globalThis.fetch;
    replayingStripe((endpoint): StripeAnswer => {
      if (endpoint !== "/v1/payment_links") {
        return { body: { id: endpoint === "/v1/prices" ? "price_1" : "shr_1" }, status: 200 };
      }
      return { body: { id: "plink_1" }, status: 200 };
    }, sellers);
    store.grantApproval(ctx.run.taskId, PRINT_ACTION);

    const listed = await outcomeOf(ctx, "sell_print", PRINT);
    expect(listed.kind).toBe("refused");
    expect(listed.text).toContain("Stripe may have made the payment link");
    expect(logged).toHaveBeenCalledExactlyOnceWith(
      "[Stripe print payment link]",
      expect.any(z.ZodError),
    );
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
      said: "https://acme-site.vercel.app:8443/print/tee-1.png names port 8443: Vercel serves the product only on https's own port, so name the URL without one.",
      url: "https://acme-site.vercel.app:8443/print/tee-1.png",
    },
    {
      said: "https://cdn.example.com/tee.png is not on Acme's production domains (acme-site.vercel.app)",
      url: "https://cdn.example.com/tee.png",
    },
  ])("refuses a print file Printful should not fetch: $said", async ({ said, url }) => {
    const { ctx, asked, sent } = sellingRun();
    const placements = [{ ...PRINT.placements[0], fileUrl: url }];
    expect(await callTool(ctx, "sell_print", { ...PRINT, placements })).toContain(said);
    expect(asked).toEqual([]);
    expect(outward(sent)).toEqual([]);
  });

  it("refuses a file the site answers with its page rather than an image", async () => {
    const { ctx, sent } = sellingRun({}, { fileType: "text/html" });
    expect(await callTool(ctx, "sell_print", PRINT)).toBe(
      "Printful could not fetch https://acme-site.vercel.app/print/tee-1.png: it serves text/html, not an image. Deploy the print file first, and check it loads as an image.",
    );
    expect(outward(sent)).toEqual([]);
  });

  it.each([
    {
      ask: {
        integration: "printful",
        productId: null,
        reason: 'to print and ship "Launch tee"',
        type: "integration",
      },
      missing: { printful: true },
      said: "a Printful card waiting that takes them to the Budget panel",
    },
    {
      ask: {
        integration: "stripe",
        productId: null,
        reason: 'to sell "Launch tee" at $28.00 through a payment link',
        type: "integration",
      },
      missing: { stripe: true },
      said: "a Stripe card waiting",
    },
    {
      ask: {
        integration: "vercel",
        productId: "acme",
        reason: "to check where Acme serves its print files",
        type: "integration",
      },
      missing: { vercel: true },
      said: "Vercel is not connected",
    },
  ])(
    "leaves the founder a $ask.integration card for a missing key",
    async ({ ask, missing, said }) => {
      const { ctx, asked, sent } = sellingRun(missing);
      expect(await callTool(ctx, "sell_print", PRINT)).toContain(said);
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

    expect(await callTool(ctx, "sell_print", PRINT)).toContain(
      "Printful turned IdleBiz's token away, which happens when it expires",
    );
    expect(asked).toMatchObject([{ integration: "printful", type: "integration" }]);
  });

  it("refuses a bet whose money the listing could not be counted for", async () => {
    const { ctx, sent } = sellingRun();
    expect(await callTool(ctx, "sell_print", { ...PRINT, bet: "no-such-bet" })).toContain(
      '"no-such-bet" is not a revenue bet on acme',
    );
    expect(sent).toEqual([]);
  });

  it("still lists a signed print for a bet the lead measures while it waited, since that money counts", async () => {
    const { ctx, sent } = sellingRun();
    const bet = revenueBet();
    store.grantApproval(ctx.run.taskId, `${PRINT_ACTION} for bet ${bet.id}`);
    store.measureBet(bet.id, Date.now());

    expect(await callTool(ctx, "sell_print", { ...PRINT, bet: bet.id })).toContain(
      'Listed "Launch tee" on Acme',
    );
    expect(outward(sent).filter((s) => s.host === "api.stripe.com")).not.toEqual([]);
  });

  it("tells a product with no Vercel project to deploy the file first", async () => {
    const { ctx, sent } = sellingRun();
    store.setProductVercel("acme", null);
    expect(await callTool(ctx, "sell_print", PRINT)).toBe(
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
    printCatalog: (query) => {
      queries.push(query);
      return Promise.resolve(read);
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
    expect(await callTool(ctx, "printful_catalog", {})).toBe(
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
    expect(await callTool(ctx, "printful_catalog", { product: 71 })).toBe(
      "71: Unisex Staple T-Shirt\nPlacements, as sell_print's placement (technique): front (dtg)\nVariants, as sell_print's variantIds (id: colour / size):\n4012: Black / S\n4013: Black / M",
    );
    expect(queries).toEqual([{ product: 71 }]);
  });

  it("leaves the founder a Printful card with no token", async () => {
    const { asked, ctx, queries } = catalogRun({ kind: "refused" }, { printful: true });
    expect(await callTool(ctx, "printful_catalog", {})).toContain("IdleBiz has no Printful token");
    expect(queries).toEqual([]);
    expect(asked).toMatchObject([{ integration: "printful", type: "integration" }]);
  });

  it("asks for a new token once Printful turns the saved one away", async () => {
    const { asked, ctx } = catalogRun({ kind: "refused" });
    expect(await callTool(ctx, "printful_catalog", {})).toContain(
      "Printful turned IdleBiz's token away",
    );
    expect(asked).toMatchObject([{ integration: "printful", type: "integration" }]);
  });
});
