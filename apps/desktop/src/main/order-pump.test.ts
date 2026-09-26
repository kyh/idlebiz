import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";
import type { CheckoutSession } from "./stripe-checkouts";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-orders-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const store = await import("./store/store");
const { orderIdOf, pumpOrders } = await import("./order-pump");
const { settleOrderCard } = await import("./company-actions");

const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
const LISTED_AT = NOW - 86_400_000;
const LINK = "plink_tee";
const FILE_URL = "https://acme-site.vercel.app/print/tee-1.png";
const DESIGN = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]);
const DESIGN_SHA = createHash("sha256").update(DESIGN).digest("hex");

/** A checkout on the tee's link: paid, shipped to Illinois, for the black M, $35.99 all told. */
const checkout = (id: string, over: Partial<CheckoutSession> = {}): CheckoutSession => ({
  amount_total: 3599,
  collected_information: {
    shipping_details: {
      address: {
        city: "Springfield",
        country: "US",
        line1: "1 Main St",
        line2: null,
        postal_code: "62701",
        state: "IL",
      },
      name: "Ada Buyer",
    },
  },
  created: NOW_S - 3600,
  currency: "usd",
  custom_fields: [{ dropdown: { value: "4013" }, key: "variant" }],
  customer_details: { email: "ada@example.com", phone: null },
  id,
  line_items: { data: [{ quantity: 1 }] },
  livemode: true,
  payment_intent: `pi_${id}`,
  payment_link: LINK,
  payment_status: "paid",
  status: "complete",
  ...over,
});

interface PrintfulOrder {
  id: number;
  external_id: string;
  status: string;
  body: JsonValue;
  /** Reads left before its costs are worked out. */
  pricingReads: number;
}

const CreatedSchema = z.object({ external_id: z.string() });

interface WorldSetup {
  sessions?: CheckoutSession[];
  totalUsd?: string;
  pricingReads?: number;
  design?: Uint8Array;
  lostConfirmations?: number;
}

const notFound = () => Response.json({ code: 404 }, { status: 404 });

/**
 * Stripe's checkouts, the product's site and Printful's orders, faked at fetch. Printful prices
 * a draft at `totalUsd` once `pricingReads` reads have seen it calculating; `lostConfirmations`
 * confirmations go through but answer 500, as a timeout would.
 */
const fakeWorld = ({
  sessions = [],
  totalUsd = "24.10",
  pricingReads = 0,
  design = DESIGN,
  lostConfirmations = 0,
}: WorldSetup = {}) => {
  const checkoutReads: number[] = [];
  const orders = new Map<number, PrintfulOrder>();
  const world = {
    checkoutReads,
    confirmations: 0,
    creates: 0,
    lostConfirmations,
    orders,
    sessions,
  };
  const orderJson = (order: PrintfulOrder) => ({
    data: {
      costs:
        order.pricingReads <= 0
          ? { calculation_status: "done", currency: "USD", total: totalUsd }
          : { calculation_status: "calculating", currency: "USD", total: null },
      external_id: order.external_id,
      id: order.id,
      status: order.status,
    },
  });
  const byExternalId = (ext: string) => [...orders.values()].find((o) => o.external_id === ext);
  const create = (init: RequestInit | undefined) => {
    const body = parseJson(z.string().parse(init?.body));
    const ext = CreatedSchema.parse(body).external_id;
    if (byExternalId(ext)) {
      return Response.json({ error: { message: "External ID already in use" } }, { status: 400 });
    }
    world.creates += 1;
    const order = {
      body,
      external_id: ext,
      id: 9000 + world.creates,
      pricingReads,
      status: "draft",
    };
    orders.set(order.id, order);
    return Response.json(orderJson(order));
  };
  const confirm = (order: PrintfulOrder | undefined) => {
    if (order?.status !== "draft") {
      return Response.json({ code: 400 }, { status: 400 });
    }
    world.confirmations += 1;
    order.status = "pending";
    if (world.lostConfirmations > 0) {
      world.lostConfirmations -= 1;
      return new Response(null, { status: 500 });
    }
    return Response.json(orderJson(order));
  };
  const read = (order: PrintfulOrder | undefined) => {
    if (!order) {
      return notFound();
    }
    const answer = orderJson(order);
    order.pricingReads -= 1;
    return Response.json(answer);
  };
  const printful = (pathname: string, init: RequestInit | undefined): Response => {
    const ext = /^\/v2\/orders\/@(?<ext>.+)$/u.exec(pathname)?.groups?.ext;
    if (ext !== undefined) {
      const found = byExternalId(ext);
      return found ? Response.json(orderJson(found)) : notFound();
    }
    if (pathname === "/v2/orders" && init?.method === "POST") {
      return create(init);
    }
    const confirming = /^\/v2\/orders\/(?<id>\d+)\/confirmation$/u.exec(pathname)?.groups?.id;
    if (confirming !== undefined) {
      return confirm(orders.get(Number(confirming)));
    }
    return read(orders.get(Number(/^\/v2\/orders\/(?<id>\d+)$/u.exec(pathname)?.groups?.id)));
  };
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const { host, pathname, searchParams } = new URL(url);
    if (host === "api.stripe.com" && pathname === "/v1/checkout/sessions") {
      const after = Number(searchParams.get("created[gt]"));
      checkoutReads.push(after);
      const data = world.sessions.filter((session) => session.created > after);
      return Promise.resolve(Response.json({ data, has_more: false }));
    }
    if (host === "acme-site.vercel.app") {
      return Promise.resolve(new Response(design, { headers: { "content-type": "image/png" } }));
    }
    return host === "api.printful.com"
      ? Promise.resolve(printful(pathname, init))
      : Promise.reject(new Error(`unexpected call to ${url}`));
  });
  return world;
};

const saveSecrets = (stripeKey = "rk_live_founder") => {
  writeFileSync(
    path.join(root, "secrets.json"),
    JSON.stringify({
      PRINTFUL_STORE: JSON.stringify({ id: 42, name: "Acme Prints" }),
      PRINTFUL_TOKEN: "pf_founder_token",
      STRIPE_SECRET_KEY: stripeKey,
    }),
  );
};

/** Acme, selling a tee in black S and M at $28 plus $7.99 shipping through `LINK`. */
const openShop = () => {
  store.foundCompany({
    budget: { mode: "infinite" },
    businessType: "ecommerce",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [
      {
        name: "Priya",
        persona: "ships",
        role: "engineer",
        runner: "claude",
        spriteSeed: "Priya",
        title: "Engineer",
      },
    ],
    mission: "sell tees",
    name: "Acme",
  });
  const productId = store.listProducts()[0]?.id ?? "";
  store.recordListing({
    betId: null,
    costCents: 1820,
    createdAt: LISTED_AT,
    id: "launch-tee",
    livemode: true,
    name: "Launch tee",
    paymentLink: { id: LINK, url: "https://buy.stripe.com/tee" },
    placements: [{ fileUrl: FILE_URL, placement: "front", sha256: DESIGN_SHA, technique: "dtg" }],
    priceCents: 2800,
    productId,
    shippingCents: 799,
    variants: [
      { id: 4012, label: "Black / S" },
      { id: 4013, label: "Black / M" },
    ],
  });
  saveSecrets();
  return productId;
};

const orderCards = () =>
  store.listOpenTasks().filter((t) => t.origin === "order" && t.state.kind === "blocked");

const onlySale = () => {
  const [order] = store.listOrders();
  if (order?.kind !== "sale") {
    throw new Error("no sale was kept");
  }
  return order;
};

/** A read and then enough pulses to price and confirm what it sent. */
const pumpUntilSettled = async (pulses = 3) => {
  await pumpOrders(NOW, true);
  for (let i = 0; i < pulses; i += 1) {
    await pumpOrders(NOW, false);
  }
};

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});

afterEach(() => {
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

describe("the order pump", () => {
  it("sends only paid checkouts on a listing's link to Printful, as drafts built from the listing", async () => {
    const productId = openShop();
    const world = fakeWorld({
      sessions: [
        checkout("cs_paid"),
        checkout("cs_unpaid", { payment_status: "unpaid" }),
        checkout("cs_open", { payment_status: "unpaid", status: "open" }),
        checkout("cs_elsewhere", { payment_link: "plink_someone_else" }),
      ],
    });

    await pumpOrders(NOW, true);

    expect(store.listOrders().map((o) => o.sessionId)).toEqual(["cs_paid"]);
    expect(world.creates).toBe(1);
    expect([...world.orders.values()][0]?.body).toEqual({
      external_id: orderIdOf("cs_paid"),
      order_items: [
        {
          catalog_variant_id: 4013,
          name: "Launch tee",
          placements: [
            { layers: [{ type: "file", url: FILE_URL }], placement: "front", technique: "dtg" },
          ],
          quantity: 1,
          retail_price: "28.00",
          source: "catalog",
        },
      ],
      recipient: {
        address1: "1 Main St",
        city: "Springfield",
        country_code: "US",
        email: "ada@example.com",
        name: "Ada Buyer",
        state_code: "IL",
        zip: "62701",
      },
      retail_costs: { currency: "USD", shipping: "7.99" },
      shipping: "STANDARD",
    });
    expect(onlySale()).toMatchObject({
      collectedCents: 3599,
      paymentIntent: "pi_cs_paid",
      productId,
      stage: { kind: "pricing", printfulId: 9001 },
      variant: { id: 4013, label: "Black / M" },
    });
    expect(store.recentTeamMessages().at(-1)?.text).toBe(
      `📦 Sold Launch tee (Black / M) for $35.99 on ${productId}: it goes to Printful now.`,
    );
    expect(orderIdOf("cs_paid")).toMatch(/^[\w-]{32}$/u);
  });

  it("confirms a draft Printful priced at no more than the buyer paid, once", async () => {
    openShop();
    const world = fakeWorld({ pricingReads: 2, sessions: [checkout("cs_paid")] });

    await pumpUntilSettled(5);

    expect(world.confirmations).toBe(1);
    expect(onlySale()).toMatchObject({
      costCents: 2410,
      printfulStatus: "pending",
      stage: { kind: "confirmed", printfulId: 9001 },
    });
    expect(orderCards()).toEqual([]);
  });

  it("never makes an order twice for a checkout read again, or one a restart finds already sent", async () => {
    openShop();
    const world = fakeWorld({ sessions: [checkout("cs_paid")] });
    await pumpOrders(NOW, true);
    // the next read overlaps the last, and a restart reads everything again
    await pumpOrders(NOW + 600_000, true);
    store.initStore();
    await pumpOrders(NOW + 1_200_000, true);
    expect(store.listOrders()).toHaveLength(1);
    expect(world.creates).toBe(1);

    // a crash after Printful made the order, before the save knew: it is found by its id
    const [kept] = store.listOrders();
    if (kept?.kind !== "sale") {
      throw new Error("no sale");
    }
    store.updateSale(kept.id, { stage: { kind: "received", tries: 0 } });
    await pumpOrders(NOW + 1_800_000, true);
    expect(world.creates).toBe(1);
    expect(world.confirmations).toBe(1);
    expect(onlySale().stage).toEqual({ kind: "confirmed", printfulId: 9001 });
  });

  it("never confirms twice when a confirmation's answer is lost", async () => {
    openShop();
    const world = fakeWorld({ lostConfirmations: 1, sessions: [checkout("cs_paid")] });

    await pumpUntilSettled(4);

    expect(world.confirmations).toBe(1);
    expect(onlySale()).toMatchObject({
      printfulStatus: "pending",
      stage: { kind: "confirmed", printfulId: 9001 },
    });
  });

  it("leaves a draft that costs more than the buyer paid, and hands the founder the numbers", async () => {
    openShop();
    const world = fakeWorld({ sessions: [checkout("cs_paid")], totalUsd: "36.50" });

    await pumpUntilSettled();

    expect(world.confirmations).toBe(0);
    expect(onlySale()).toMatchObject({
      costCents: 3650,
      stage: { kind: "held", printfulId: 9001 },
    });
    const [card] = orderCards();
    expect(card?.title).toBe(
      `Order ${orderIdOf("cs_paid").slice(0, 8)}: Printful wants more than the buyer paid`,
    );
    expect(card?.assigneeId).toBeNull();
    const ask = card?.state.kind === "blocked" ? card.state.ask : null;
    expect(ask?.type).toBe("action");
    expect(ask?.type === "action" ? `${ask.action}\n${ask.instructions}` : "").toContain(
      "Ada Buyer's Launch tee (Black / M), ada@example.com: paid $35.99 on acme, Stripe payment pi_cs_paid\nPrintful charges $36.50 to print and ship it, and the buyer paid $35.99",
    );

    // pumping on raises no second card, and the founder's answer closes it without a run
    await pumpUntilSettled();
    expect(orderCards()).toHaveLength(1);
    settleOrderCard(card?.id ?? "", { kind: "done", note: "refunded" });
    expect(orderCards()).toEqual([]);
    expect(store.listOpenTasks()).toEqual([]);
    expect(store.recentTeamMessages().at(-1)?.text).toContain("done — refunded");
  });

  it("hands the founder an order Printful marks failed", async () => {
    openShop();
    const world = fakeWorld({ sessions: [checkout("cs_paid")] });
    await pumpUntilSettled();
    const [sent] = world.orders.values();
    if (!sent) {
      throw new Error("nothing was sent");
    }
    sent.status = "failed";

    await pumpOrders(NOW + 600_000, true);

    expect(onlySale().printfulStatus).toBe("failed");
    expect(orderCards().map((t) => t.title)).toEqual([
      `Order ${orderIdOf("cs_paid").slice(0, 8)}: Printful marked it failed`,
    ]);
    const [card] = orderCards();
    const ask = card?.state.kind === "blocked" ? card.state.ask : null;
    expect(ask?.type === "action" ? ask.instructions : "").toContain("refund the buyer in Stripe");
  });

  it("keeps where the next read starts, holding it for a checkout that may still be paid", async () => {
    openShop();
    const openedAt = NOW_S - 7200;
    const world = fakeWorld({
      sessions: [
        checkout("cs_open", { created: openedAt, payment_status: "unpaid", status: "open" }),
      ],
    });

    await pumpOrders(NOW, true);
    expect(world.checkoutReads).toEqual([LISTED_AT / 1000 - 1]);
    expect(store.ordersCursor()).toBe(openedAt - 1);

    // it expires unpaid: the cursor moves up to a little before the read
    world.sessions = [
      checkout("cs_open", { created: openedAt, payment_status: "unpaid", status: "expired" }),
    ];
    store.initStore();
    await pumpOrders(NOW, true);
    expect(world.checkoutReads.at(-1)).toBe(openedAt - 1);
    expect(store.ordersCursor()).toBe(NOW_S - 600);
  });

  it("prices a test-mode checkout but never confirms it, since nobody paid", async () => {
    openShop();
    const world = fakeWorld({ sessions: [checkout("cs_test", { livemode: false })] });

    await pumpUntilSettled();

    expect(world.confirmations).toBe(0);
    expect(onlySale()).toMatchObject({
      costCents: 2410,
      stage: { kind: "test", printfulId: 9001 },
    });
  });

  it("sends nothing for a design that changed since the founder signed it", async () => {
    openShop();
    const world = fakeWorld({ design: new Uint8Array([1, 2, 3]), sessions: [checkout("cs_paid")] });

    await pumpOrders(NOW, true);

    expect(world.creates).toBe(0);
    expect(onlySale().stage).toMatchObject({ kind: "held", printfulId: null });
    expect(orderCards().map((t) => t.title)).toEqual([
      `Order ${orderIdOf("cs_paid").slice(0, 8)}: its design changed`,
    ]);
  });

  it("keeps a paid checkout it cannot send, and hands it to the founder", async () => {
    openShop();
    const world = fakeWorld({
      sessions: [checkout("cs_nowhere", { collected_information: null })],
    });

    await pumpOrders(NOW, true);

    expect(world.creates).toBe(0);
    expect(store.listOrders()).toMatchObject([
      { kind: "unreadable", why: "Stripe's checkout carries no whole US shipping address" },
    ]);
    expect(orderCards()).toHaveLength(1);
  });

  it("asks Stripe nothing while no listing is on sale", async () => {
    store.foundCompany({
      budget: { mode: "infinite" },
      businessType: "software",
      founderName: "Kai",
      founderSpriteSeed: "seed",
      hires: [],
      mission: "ship",
      name: "Acme",
    });
    saveSecrets();
    const world = fakeWorld();

    await pumpOrders(NOW, true);

    expect(world.checkoutReads).toEqual([]);
  });
});
