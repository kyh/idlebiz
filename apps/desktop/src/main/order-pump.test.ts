import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const { ordersDir } = await import("./paths");
const { CHECKOUTS_READ_MS, orderIdOf, pumpOrders } = await import("./order-pump");
const { retireProduct, settleOrderCard } = await import("./company-actions");

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
  /** The status a confirmation leaves the order in. */
  confirmedAs?: string;
  /** Creates that make the draft but answer 500, as a timeout would. */
  lostCreates?: number;
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
  confirmedAs = "pending",
  lostCreates = 0,
}: WorldSetup = {}) => {
  const checkoutReads: number[] = [];
  const switchedOff: string[] = [];
  const orders = new Map<number, PrintfulOrder>();
  const world = {
    /** Called as a confirmation arrives, before Printful acts on it. */
    beforeConfirm: (_order: PrintfulOrder): void => {},
    checkoutReads,
    confirmations: 0,
    creates: 0,
    discards: 0,
    /** Whether Stripe says every page has more after it. */
    endless: false,
    lostConfirmations,
    lostCreates,
    orders,
    /** Payments the founder refunded in Stripe. */
    refunded: new Set<string>(),
    sessions,
    /** Payment links switched off, by id. */
    switchedOff,
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
    if (world.lostCreates > 0) {
      world.lostCreates -= 1;
      return new Response(null, { status: 500 });
    }
    return Response.json(orderJson(order));
  };
  const confirm = (order: PrintfulOrder | undefined) => {
    if (order) {
      world.beforeConfirm(order);
    }
    if (order?.status !== "draft") {
      return Response.json({ code: 400 }, { status: 400 });
    }
    world.confirmations += 1;
    order.status = confirmedAs;
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
    const id = Number(/^\/v2\/orders\/(?<id>\d+)$/u.exec(pathname)?.groups?.id);
    if (init?.method === "DELETE") {
      world.discards += 1;
      return orders.delete(id) ? new Response(null, { status: 204 }) : notFound();
    }
    return read(orders.get(id));
  };
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const { host, pathname, searchParams } = new URL(url);
    // a key lists only the sessions of its own mode
    const live = !new Headers(init?.headers).get("Authorization")?.includes("_test_");
    if (host === "api.stripe.com" && pathname === "/v1/checkout/sessions") {
      const after = Number(searchParams.get("created[gt]"));
      checkoutReads.push(after);
      const data = world.sessions.filter(
        (session) => session.created > after && session.livemode === live,
      );
      return Promise.resolve(Response.json({ data, has_more: world.endless }));
    }
    if (host === "api.stripe.com" && pathname === "/v1/charges") {
      const intent = searchParams.get("payment_intent") ?? "";
      const refunded = world.refunded.has(intent) ? 3599 : 0;
      return Promise.resolve(
        Response.json({ data: [{ amount_refunded: refunded, disputed: false, paid: true }] }),
      );
    }
    const link = /^\/v1\/payment_links\/(?<id>\w+)$/u.exec(pathname)?.groups?.id;
    if (host === "api.stripe.com" && link !== undefined && init?.method === "POST") {
      switchedOff.push(link);
      return Promise.resolve(Response.json({ active: false, id: link }));
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
    paymentLink: { id: LINK, state: { kind: "selling" }, url: "https://buy.stripe.com/tee" },
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

/** Where each key's next read of checkouts starts. */
const readFrom = () => Object.values(store.ordersCursor()?.byKey ?? {});

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
  await pumpOrders(NOW, "read");
  for (let i = 0; i < pulses; i += 1) {
    await pumpOrders(NOW, "price");
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

    await pumpOrders(NOW, "read");

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
    await pumpOrders(NOW, "read");
    // the next read overlaps the last, and a restart reads everything again
    await pumpOrders(NOW + 600_000, "read");
    store.initStore();
    await pumpOrders(NOW + 1_200_000, "read");
    expect(store.listOrders()).toHaveLength(1);
    expect(world.creates).toBe(1);

    // a crash after Printful made the order, before the save knew: it is found by its id
    const [kept] = store.listOrders();
    if (kept?.kind !== "sale") {
      throw new Error("no sale");
    }
    store.updateSale(kept.id, { stage: { kind: "received", tries: 0 } });
    await pumpOrders(NOW + 1_800_000, "read");
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

    await pumpOrders(NOW + 600_000, "read");

    expect(onlySale().printfulStatus).toBe("failed");
    expect(orderCards().map((t) => t.title)).toEqual([
      `Order ${orderIdOf("cs_paid").slice(0, 8)}: Printful marked it failed`,
    ]);
    const [card] = orderCards();
    const ask = card?.state.kind === "blocked" ? card.state.ask : null;
    expect(ask?.type === "action" ? ask.instructions : "").toContain("refund the buyer in Stripe");
  });

  it("hands the founder an order Printful's confirmation answers onhold", async () => {
    openShop();
    fakeWorld({ confirmedAs: "onhold", sessions: [checkout("cs_paid")] });

    await pumpUntilSettled();
    await pumpOrders(NOW + 600_000, "track");
    await pumpOrders(NOW + 1_200_000, "track");

    expect(onlySale()).toMatchObject({
      printfulStatus: "onhold",
      stage: { kind: "confirmed", printfulId: 9001 },
    });
    expect(orderCards().map((t) => t.title)).toEqual([
      `Order ${orderIdOf("cs_paid").slice(0, 8)}: Printful marked it onhold`,
    ]);
  });

  it("hands the founder an order first read failed after its confirmation's answer was lost", async () => {
    openShop();
    const world = fakeWorld({
      confirmedAs: "failed",
      lostConfirmations: 1,
      sessions: [checkout("cs_paid")],
    });

    await pumpUntilSettled(4);

    expect(world.confirmations).toBe(1);
    expect(onlySale().printfulStatus).toBe("failed");
    expect(orderCards()).toHaveLength(1);
  });

  it("hands the founder a failed order a restart finds by its external id", async () => {
    openShop();
    const world = fakeWorld({ sessions: [checkout("cs_paid")] });
    await pumpUntilSettled();
    const [sent] = world.orders.values();
    if (!sent) {
      throw new Error("nothing was sent");
    }
    sent.status = "failed";
    // a crash before the save knew what Printful made
    store.updateSale(onlySale().id, {
      printfulStatus: null,
      stage: { kind: "received", tries: 0 },
    });

    await pumpOrders(NOW + 600_000, "track");

    expect(world.creates).toBe(1);
    expect(onlySale()).toMatchObject({
      printfulStatus: "failed",
      stage: { kind: "confirmed", printfulId: 9001 },
    });
    expect(orderCards()).toHaveLength(1);
  });

  it("takes on a draft the founder confirmed by hand just before IdleBiz did, with no card", async () => {
    openShop();
    const world = fakeWorld({ sessions: [checkout("cs_paid")] });
    world.beforeConfirm = (order) => {
      order.status = "pending";
    };

    await pumpUntilSettled();

    expect(world.confirmations).toBe(0);
    expect(onlySale()).toMatchObject({
      printfulStatus: "pending",
      stage: { kind: "confirmed", printfulId: 9001 },
    });
    expect(orderCards()).toEqual([]);
  });

  it("still ships and tracks a retired product's orders, and takes those its live link still sells", async () => {
    const productId = openShop();
    store.createProduct({ description: "the next idea", name: "Next" });
    const world = fakeWorld({ pricingReads: 2, sessions: [checkout("cs_paid")] });
    await pumpOrders(NOW, "read");
    store.killProduct(productId, "dud", null);

    await pumpUntilSettled(4);
    world.sessions.push(checkout("cs_later", { created: NOW_S + 60 }));
    await pumpOrders(NOW + CHECKOUTS_READ_MS, "read");
    await pumpUntilSettled(4);

    expect(world.confirmations).toBe(2);
    expect(store.listOrders().map((o) => [o.sessionId, o.productId])).toEqual([
      ["cs_paid", productId],
      ["cs_later", productId],
    ]);
    expect(orderCards()).toEqual([]);
  });

  it("still ships what a retired product's switched-off link was paid, even a checkout opened before and paid after", async () => {
    const productId = openShop();
    store.createProduct({ description: "the next idea", name: "Next" });
    const world = fakeWorld({ sessions: [checkout("cs_paid")] });
    await pumpOrders(NOW, "read");

    await retireProduct(productId, "dud", null);
    world.sessions.push(checkout("cs_late", { created: NOW_S - 60 }));
    await pumpOrders(NOW + CHECKOUTS_READ_MS, "read");
    await pumpUntilSettled(4);

    expect(world.switchedOff).toEqual([LINK]);
    expect(store.getListing("launch-tee")?.paymentLink.state.kind).toBe("switched-off");
    expect(world.confirmations).toBe(2);
    expect(store.listOrders().map((o) => [o.sessionId, o.productId])).toEqual([
      ["cs_paid", productId],
      ["cs_late", productId],
    ]);
    expect(orderCards()).toEqual([]);
    expect(store.recentTeamMessages(50).map((m) => m.text)).toContain(
      `📦 Sold Launch tee (Black / M) for $35.99 on ${productId}, paid on a link since switched off: it goes to Printful now.`,
    );
  });

  it("moves past checkouts one read cannot reach, and tells the founder", async () => {
    openShop();
    const world = fakeWorld({ sessions: [checkout("cs_paid")] });
    world.endless = true;

    await pumpOrders(NOW, "read");

    expect(readFrom()).toEqual([NOW_S - 3601]);
    expect(orderCards().map((t) => t.title)).toEqual(["Paid orders may have been missed"]);
    expect(store.listOrders()).toHaveLength(1);
  });

  it("keeps where the next read starts, holding it for a checkout that may still be paid", async () => {
    openShop();
    const openedAt = NOW_S - 7200;
    const world = fakeWorld({
      sessions: [
        checkout("cs_open", { created: openedAt, payment_status: "unpaid", status: "open" }),
      ],
    });

    await pumpOrders(NOW, "read");
    const foundedAt = store.requireCompany().createdAt;
    expect(world.checkoutReads).toEqual([Math.floor(foundedAt / 1000) - 1]);
    expect(readFrom()).toEqual([openedAt - 1]);

    // it expires unpaid: the cursor moves up to a little before the read
    world.sessions = [
      checkout("cs_open", { created: openedAt, payment_status: "unpaid", status: "expired" }),
    ];
    store.initStore();
    await pumpOrders(NOW, "read");
    expect(world.checkoutReads.at(-1)).toBe(openedAt - 1);
    expect(readFrom()).toEqual([NOW_S - 600]);
  });

  it("prices a test-mode checkout, then deletes its draft, since nobody paid, even one dearer than the payment", async () => {
    openShop();
    saveSecrets("rk_test_founder");
    const world = fakeWorld({
      sessions: [checkout("cs_test", { livemode: false })],
      totalUsd: "36.50",
    });

    await pumpUntilSettled();

    expect(world.confirmations).toBe(0);
    expect(world.discards).toBe(1);
    expect(world.orders.size).toBe(0);
    expect(onlySale()).toMatchObject({
      costCents: 3650,
      printfulStatus: "deleted",
      stage: { kind: "test", printfulId: 9001 },
    });
    expect(orderCards()).toEqual([]);
  });

  it("sends nothing for a design that changed since the founder signed it", async () => {
    openShop();
    const world = fakeWorld({ design: new Uint8Array([1, 2, 3]), sessions: [checkout("cs_paid")] });

    await pumpOrders(NOW, "read");

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

    await pumpOrders(NOW, "read");

    expect(world.creates).toBe(0);
    expect(store.listOrders()).toMatchObject([
      { kind: "unreadable", why: "Stripe's checkout carries no whole US shipping address" },
    ]);
    expect(orderCards()).toHaveLength(1);
  });

  it("asks Stripe nothing without a key", async () => {
    openShop();
    writeFileSync(path.join(root, "secrets.json"), JSON.stringify({ PRINTFUL_TOKEN: "pf_token" }));
    const world = fakeWorld({ sessions: [checkout("cs_paid")] });

    await pumpOrders(NOW, "read");

    expect(world.checkoutReads).toEqual([]);
  });

  it("keeps each paid checkout on a create_payment_link link, and cards the founder only for a live one with a delivery", async () => {
    store.foundCompany({
      budget: { mode: "infinite" },
      businessType: "vc",
      founderName: "Kai",
      founderSpriteSeed: "seed",
      hires: [],
      mission: "sell deal memos",
      name: "Acme",
    });
    saveSecrets();
    const productId = store.listProducts()[0]?.id ?? "";
    const memo = (id: string, over: Partial<CheckoutSession> = {}) =>
      checkout(id, {
        amount_total: 900,
        collected_information: null,
        custom_fields: null,
        line_items: { data: [{ description: "Acme teardown", quantity: 1 }] },
        metadata: { delivery: "Email the PDF at memos/acme.pdf", product: productId },
        payment_link: "plink_memo",
        ...over,
      });
    const world = fakeWorld({
      sessions: [
        memo("cs_delivered"),
        memo("cs_tip", { metadata: { product: productId } }),
        memo("cs_unpaid", { payment_status: "unpaid" }),
        memo("cs_foreign", { metadata: { delivery: "x", product: "someone-elses" } }),
        memo("cs_lost_listing", { metadata: { listing: "gone", product: productId } }),
      ],
    });

    await pumpOrders(NOW, "read");

    expect(world.creates).toBe(0);
    expect(store.listOrders()).toMatchObject([
      { delivery: "Email the PDF at memos/acme.pdf", kind: "link", name: "Acme teardown" },
      { delivery: null, kind: "link", sessionId: "cs_tip" },
      { kind: "unreadable", listingId: "gone", sessionId: "cs_lost_listing" },
    ]);
    const cards = orderCards();
    expect(cards.map((t) => t.title)).toEqual([
      `Order ${orderIdOf("cs_lost_listing").slice(0, 8)}: IdleBiz cannot send it`,
      `Order ${orderIdOf("cs_delivered").slice(0, 8)}: deliver it`,
    ]);
    expect(cards[1]?.state).toMatchObject({
      ask: {
        action: 'Send ada@example.com what "Acme teardown" promised',
        instructions: `"Acme teardown", ada@example.com: paid $9.00 on ${productId}, Stripe payment pi_cs_delivered. The team says to send: Email the PDF at memos/acme.pdf Press Done once it is sent. If you can't deliver it, refund the buyer in Stripe.`,
      },
    });
    expect(store.recentTeamMessages().map((m) => m.text)).toEqual([
      `💵 Sold "Acme teardown" for $9.00 on ${productId}: the founder delivers it.`,
      `💵 Sold "Acme teardown" for $9.00 on ${productId}.`,
    ]);

    // a retired product's link nobody switched off still takes money, and its buyer is still owed
    store.createProduct({ description: "the next idea", name: "Next" });
    store.killProduct(productId, "dud", null);
    world.sessions.push(memo("cs_after", { created: NOW_S + 60 }));
    await pumpOrders(NOW + CHECKOUTS_READ_MS, "read");
    expect(store.listOrders().at(-1)).toMatchObject({ productId, sessionId: "cs_after" });
    expect(orderCards()).toHaveLength(3);
  });

  it("keeps each key's place, so a live sale paid while a test key was saved is still taken", async () => {
    openShop();
    const world = fakeWorld({ sessions: [checkout("cs_before")] });
    await pumpOrders(NOW, "read");

    saveSecrets("rk_test_founder");
    world.sessions.push(checkout("cs_while_testing", { created: NOW_S + 600 }));
    await pumpOrders(NOW + CHECKOUTS_READ_MS, "read");
    await pumpOrders(NOW + 2 * CHECKOUTS_READ_MS, "read");
    expect(store.listOrders().map((o) => o.sessionId)).toEqual(["cs_before"]);

    saveSecrets();
    await pumpOrders(NOW + 3 * CHECKOUTS_READ_MS, "read");
    expect(store.listOrders().map((o) => o.sessionId)).toEqual(["cs_before", "cs_while_testing"]);
    expect(world.checkoutReads.at(-1)).toBe(NOW_S - 600);
  });

  it("starts a rolled key where its mode's reads stopped, not from the founding", async () => {
    openShop();
    const world = fakeWorld({ sessions: [checkout("cs_paid")] });
    await pumpOrders(NOW, "read");

    saveSecrets("rk_live_rolled");
    await pumpOrders(NOW + CHECKOUTS_READ_MS, "read");

    expect(world.checkoutReads).toEqual([
      Math.floor(store.requireCompany().createdAt / 1000) - 1,
      NOW_S - 600,
    ]);
  });

  it("leaves a draft Printful prices above what Stripe's fee leaves of the payment", async () => {
    openShop();
    // $34.50 is under the $35.99 paid, but over the $34.10 Stripe's fee may leave
    const world = fakeWorld({ sessions: [checkout("cs_paid")], totalUsd: "34.50" });

    await pumpUntilSettled();

    expect(world.confirmations).toBe(0);
    expect(onlySale().stage).toMatchObject({ kind: "held", printfulId: 9001 });
    const [card] = orderCards();
    const ask = card?.state.kind === "blocked" ? card.state.ask : null;
    expect(ask?.type === "action" ? ask.instructions : "").toContain(
      "the buyer paid $35.99, of which Stripe's fee may leave $34.10",
    );
  });

  it("never confirms a draft whose payment the founder refunded in Stripe", async () => {
    openShop();
    const world = fakeWorld({ pricingReads: 1, sessions: [checkout("cs_paid")] });
    await pumpOrders(NOW, "read");
    world.refunded.add("pi_cs_paid");

    await pumpUntilSettled();

    expect(world.confirmations).toBe(0);
    expect(onlySale().stage).toMatchObject({ kind: "held", printfulId: 9001 });
    expect(orderCards().map((t) => t.title)).toEqual([
      `Order ${orderIdOf("cs_paid").slice(0, 8)}: its payment was refunded or disputed`,
    ]);
  });

  it("finds the draft a last timed-out send made, rather than have the founder place a second", async () => {
    openShop();
    const world = fakeWorld({ sessions: [checkout("cs_paid")] });
    await pumpOrders(NOW, "read");
    world.orders.clear();
    // the last try: its create makes the draft, but the answer is lost
    world.lostCreates = 1;
    store.updateSale(onlySale().id, { stage: { kind: "received", tries: 5 } });

    await pumpOrders(NOW + 600_000, "track");

    expect(world.creates).toBe(2);
    expect(onlySale().stage).toMatchObject({ kind: "pricing", printfulId: 9002 });
    expect(orderCards()).toEqual([]);
  });

  it("cards the founder even when the order cannot be kept, and only once when it is", async () => {
    const productId = openShop();
    fakeWorld({ sessions: [checkout("cs_nowhere", { collected_information: null })] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const orders = ordersDir(store.requireCompany().id);
    mkdirSync(orders, { recursive: true });
    chmodSync(orders, 0o555);
    try {
      await pumpOrders(NOW, "read");
    } finally {
      chmodSync(orders, 0o755);
      logged.mockRestore();
    }
    expect(store.listOrders()).toEqual([]);
    expect(orderCards()).toHaveLength(1);

    await pumpOrders(NOW + CHECKOUTS_READ_MS, "read");
    expect(store.listOrders()).toMatchObject([{ kind: "unreadable", productId }]);
    expect(orderCards()).toHaveLength(1);
  });

  it("tells the room, not the founder, of a test-mode checkout it cannot send", async () => {
    openShop();
    saveSecrets("rk_test_founder");
    fakeWorld({
      sessions: [checkout("cs_test", { collected_information: null, livemode: false })],
    });

    await pumpOrders(NOW, "read");

    expect(store.listOrders()).toMatchObject([{ kind: "unreadable", livemode: false }]);
    expect(orderCards()).toEqual([]);
    expect(store.recentTeamMessages().at(-1)?.text).toContain("🧪 Test order");
  });

  it("raises no card for a key that cannot read checkouts while nothing is sold", async () => {
    store.foundCompany({
      budget: { mode: "infinite" },
      businessType: "vc",
      founderName: "Kai",
      founderSpriteSeed: "seed",
      hires: [],
      mission: "sell deal memos",
      name: "Acme",
    });
    saveSecrets();
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ error: { message: "no checkout read" } }, { status: 403 })),
    );

    await pumpOrders(NOW, "read");

    expect(orderCards()).toEqual([]);
  });

  it("cards the founder when a key that cannot read checkouts leaves a link's buyers owed a delivery unread", async () => {
    store.foundCompany({
      budget: { mode: "infinite" },
      businessType: "vc",
      founderName: "Kai",
      founderSpriteSeed: "seed",
      hires: [],
      mission: "sell deal memos",
      name: "Acme",
    });
    store.recordChargeLink({
      betId: null,
      cents: 500,
      createdAt: NOW - 1000,
      delivery: "Email the PDF",
      id: "plink_memo",
      livemode: true,
      name: "Memo",
      productId: store.listProducts()[0]?.id ?? "",
      state: { kind: "selling" },
      url: "https://buy.stripe.com/memo",
    });
    saveSecrets("rk_live_rotated");
    vi.stubGlobal("fetch", () =>
      Promise.resolve(Response.json({ error: { message: "no checkout read" } }, { status: 403 })),
    );

    await pumpOrders(NOW, "read");

    expect(orderCards().map((t) => t.title)).toEqual(["Paid orders can't be read from Stripe"]);
  });

  it("deletes a test-mode draft Printful never finishes pricing, rather than leave it to be confirmed by hand", async () => {
    openShop();
    saveSecrets("rk_test_founder");
    const world = fakeWorld({
      pricingReads: 1000,
      sessions: [checkout("cs_test", { livemode: false })],
    });

    await pumpUntilSettled(25);

    expect(world.discards).toBe(1);
    expect(world.orders.size).toBe(0);
    expect(onlySale()).toMatchObject({
      costCents: null,
      printfulStatus: "deleted",
      stage: { kind: "test", printfulId: 9001 },
    });
    expect(orderCards()).toEqual([]);
    expect(store.recentTeamMessages().at(-1)?.text).toContain("🧪 Test order");
  });
});
