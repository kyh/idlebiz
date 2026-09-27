import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChargeLink } from "@/shared/payment-link";
import type { Listing } from "@/shared/listing";
import type { Sale } from "@/shared/order";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-retired-links-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const store = await import("./store/store");
const { retireProduct, settleOrderCard, switchOffBeforeReset, switchOffRetiredLinks } =
  await import("./company-actions");

const TEE = "plink_tee";
const PRO = "plink_pro";
const SANDBOX = "plink_sandbox";

type Answer = "off" | "refused" | "busy" | "down";

interface StripeSetup {
  /** How Stripe answers a switch-off of each link; one not named is switched off. */
  answers?: Partial<Record<string, Answer>>;
  /** The account's active links, as Stripe lists them. */
  active?: { id: string; url: string; metadata: Record<string, string> }[];
}

interface SwitchOff {
  id: string;
  auth: string | null;
  form: Record<string, string>;
}

/** Stripe's payment links, faked at fetch: every switch-off asked, with the key it came with. */
const fakeStripe = ({ answers = {}, active = [] }: StripeSetup = {}) => {
  const switchOffs: SwitchOff[] = [];
  const world = { lists: 0, switchOffs };
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const { host, pathname } = new URL(url);
    if (host === "api.stripe.com" && pathname === "/v1/payment_links" && !init?.method) {
      world.lists += 1;
      return Promise.resolve(Response.json({ data: active, has_more: false }));
    }
    const id = /^\/v1\/payment_links\/(?<id>\w+)$/u.exec(pathname)?.groups?.id;
    if (host !== "api.stripe.com" || id === undefined || init?.method !== "POST") {
      return Promise.reject(new Error(`unexpected call to ${url}`));
    }
    world.switchOffs.push({
      auth: new Headers(init.headers).get("Authorization"),
      form: init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {},
      id,
    });
    const answer = answers[id] ?? "off";
    if (answer === "down") {
      return Promise.reject(new TypeError("fetch failed"));
    }
    if (answer === "busy") {
      return Promise.resolve(
        Response.json({ error: { message: "Too many requests" } }, { status: 429 }),
      );
    }
    return Promise.resolve(
      answer === "refused"
        ? Response.json({ error: { message: `No such payment_link: '${id}'` } }, { status: 404 })
        : Response.json({ active: false, id }),
    );
  });
  return world;
};

const saveKey = (key: string | null) => {
  writeFileSync(
    path.join(root, "secrets.json"),
    JSON.stringify(key === null ? {} : { STRIPE_SECRET_KEY: key }),
  );
};

const listingOn = (productId: string): Listing => ({
  betId: null,
  costCents: 1820,
  createdAt: 1,
  id: "launch-tee",
  livemode: true,
  name: "Launch tee",
  paymentLink: { id: TEE, state: { kind: "selling" }, url: "https://buy.stripe.com/tee" },
  placements: [
    {
      fileUrl: "https://acme.vercel.app/tee.png",
      placement: "front",
      sha256: "a".repeat(64),
      technique: "dtg",
    },
  ],
  priceCents: 2800,
  productId,
  shippingCents: 799,
  variants: [{ id: 4012, label: "Black / S" }],
});

const chargeLinkOn = (productId: string, id: string, livemode = true): ChargeLink => ({
  betId: null,
  cents: 900,
  createdAt: 2,
  delivery: null,
  id,
  livemode,
  name: livemode ? "Pro plan" : "Sandbox plan",
  productId,
  state: { kind: "selling" },
  url: `https://buy.stripe.com/${id}`,
});

/** Acme with a side product selling a print and a plan, and the founder's live key saved. */
const openShop = () => {
  const company = store.foundCompany({
    budget: { mode: "infinite" },
    businessType: "ecommerce",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [],
    mission: "sell tees",
    name: "Acme",
  });
  const side = store.createProduct({ description: "a side bet", name: "Side" });
  store.recordListing(listingOn(side.id));
  store.recordChargeLink(chargeLinkOn(side.id, PRO));
  saveKey("rk_live_founder");
  return { company, side };
};

/** The founder's cards, by title: cards raised in one millisecond list in no fixed order. */
const cards = () =>
  store
    .listOpenTasks()
    .filter((t) => t.origin === "order" && t.state.kind === "blocked")
    .toSorted((a, b) => a.title.localeCompare(b.title));

const statesOf = () => Object.fromEntries(store.paymentLinks().map((l) => [l.id, l.state.kind]));

const roomSays = () => store.recentTeamMessages(50).map((m) => m.text);

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

describe("retiring a product", () => {
  it("switches off every payment link it sells through with the founder's key, and says so", async () => {
    const { side } = openShop();
    const stripe = fakeStripe();

    await retireProduct(side.id, "dud", null);

    expect(stripe.switchOffs).toEqual([
      { auth: "Bearer rk_live_founder", form: { active: "false" }, id: TEE },
      { auth: "Bearer rk_live_founder", form: { active: "false" }, id: PRO },
    ]);
    expect(statesOf()).toEqual({ [PRO]: "switched-off", [TEE]: "switched-off" });
    expect(cards()).toEqual([]);
    expect(roomSays()).toEqual(
      expect.arrayContaining([
        `🔌 Switched off "Launch tee", a payment link of retired ${side.id}: it takes no new money.`,
        `🔌 Switched off "Pro plan", a payment link of retired ${side.id}: it takes no new money.`,
      ]),
    );

    store.initStore();
    await switchOffRetiredLinks();

    expect(statesOf()).toEqual({ [PRO]: "switched-off", [TEE]: "switched-off" });
    expect(stripe.switchOffs).toHaveLength(2);
  });

  it("leaves a live product's links selling", async () => {
    const { side } = openShop();
    const next = store.createProduct({ description: "the next idea", name: "Next" });
    store.recordChargeLink(chargeLinkOn(next.id, "plink_next"));
    const stripe = fakeStripe();

    await retireProduct(side.id, "dud", null);

    expect(stripe.switchOffs.map((s) => s.id)).toEqual([TEE, PRO]);
    expect(statesOf()).toMatchObject({ plink_next: "selling" });
  });

  it("hands the founder one card for each link Stripe refused to switch off, and switches off the rest", async () => {
    const { side } = openShop();
    const stripe = fakeStripe({ answers: { [PRO]: "refused" } });

    const retired = await retireProduct(side.id, "dud", null);

    expect(retired.id).toBe(side.id);
    expect(store.getProduct(side.id)).toBeNull();
    expect(statesOf()).toEqual({ [PRO]: "left-on", [TEE]: "switched-off" });
    expect(cards().map((c) => c.title)).toEqual([`Switch off payment link ${PRO}`]);
    const [refused] = cards();
    expect(refused?.state).toMatchObject({
      ask: {
        action: `Switch off "Pro plan" (https://buy.stripe.com/${PRO}), a payment link of retired ${side.id}, in Stripe's dashboard`,
        type: "action",
      },
    });
    expect(JSON.stringify(refused?.state)).toContain(`No such payment_link: '${PRO}'`);

    await switchOffRetiredLinks();

    expect(stripe.switchOffs).toHaveLength(2);
    expect(cards()).toHaveLength(1);
  });

  it("asks again each sweep while Stripe is busy or out of reach, and cards the founder only once it keeps not answering", async () => {
    const { side } = openShop();
    const stripe = fakeStripe({ answers: { [PRO]: "down", [TEE]: "busy" } });

    await retireProduct(side.id, "dud", null);

    expect(statesOf()).toEqual({ [PRO]: "retrying", [TEE]: "retrying" });
    expect(cards()).toEqual([]);

    const later = fakeStripe({ answers: { [PRO]: "down" } });
    await switchOffRetiredLinks();

    expect(statesOf()).toEqual({ [PRO]: "retrying", [TEE]: "switched-off" });
    expect(store.paymentLinks().find((l) => l.id === PRO)?.state).toEqual({
      kind: "retrying",
      tries: 2,
      why: "fetch failed",
    });

    for (let sweep = 3; sweep <= 10; sweep += 1) {
      await switchOffRetiredLinks();
    }

    expect(stripe.switchOffs).toHaveLength(2);
    expect(later.switchOffs.map((s) => s.id)).toEqual([
      TEE,
      ...Array.from({ length: 9 }, () => PRO),
    ]);
    expect(statesOf()).toEqual({ [PRO]: "left-on", [TEE]: "switched-off" });
    expect(cards().map((c) => c.title)).toEqual([`Switch off payment link ${PRO}`]);
    expect(JSON.stringify(cards()[0]?.state)).toContain(
      "Stripe did not answer 10 times (fetch failed)",
    );
  });

  it("records a link the founder switched off by hand once they press Done on its card", async () => {
    const { side } = openShop();
    fakeStripe({ answers: { [PRO]: "refused", [TEE]: "refused" } });
    await retireProduct(side.id, "dud", null);
    const [pro, tee] = cards();

    settleOrderCard(pro?.id ?? "", { kind: "done", note: "" });
    settleOrderCard(tee?.id ?? "", { kind: "cant", reason: "no dashboard access" });

    expect(store.paymentLinks().find((l) => l.id === PRO)?.state).toMatchObject({
      by: "founder",
      kind: "switched-off",
    });
    expect(statesOf()).toMatchObject({ [TEE]: "left-on" });
  });

  it("switches off nothing for a live product whose PRODUCT.md boot could not read", async () => {
    const { company, side } = openShop();
    writeFileSync(path.join(root, company.id, "products", side.id, "PRODUCT.md"), "not a product");
    store.initStore();
    const stripe = fakeStripe();

    await switchOffRetiredLinks();

    expect(store.loadReport().skipped).toMatchObject([{ kind: "product" }]);
    expect(store.getProduct(side.id)).toBeNull();
    expect(stripe.switchOffs).toEqual([]);
    expect(statesOf()).toEqual({ [PRO]: "selling", [TEE]: "selling" });
    expect(cards()).toEqual([]);
  });

  it("waits for a saved key this launch cannot open, rather than hand its links over as keyless", async () => {
    const { side } = openShop();
    writeFileSync(
      path.join(root, "secrets.json"),
      JSON.stringify({ STRIPE_SECRET_KEY: "sealed:v1:c2VhbGVk" }),
    );
    const stripe = fakeStripe();

    await retireProduct(side.id, "dud", null);

    expect(stripe.switchOffs).toEqual([]);
    expect(statesOf()).toEqual({ [PRO]: "selling", [TEE]: "selling" });
    expect(cards()).toEqual([]);

    saveKey("rk_live_founder");
    await switchOffRetiredLinks();

    expect(statesOf()).toEqual({ [PRO]: "switched-off", [TEE]: "switched-off" });
  });

  it("retires without a Stripe key, carding each live link and telling the room of a test one", async () => {
    const { side } = openShop();
    store.recordChargeLink(chargeLinkOn(side.id, SANDBOX, false));
    saveKey(null);
    const stripe = fakeStripe();

    await retireProduct(side.id, "dud", null);

    expect(store.getProduct(side.id)).toBeNull();
    expect(stripe.switchOffs).toEqual([]);
    expect(statesOf()).toEqual({ [PRO]: "left-on", [SANDBOX]: "left-on", [TEE]: "left-on" });
    expect(cards().map((c) => c.title)).toEqual([
      `Switch off payment link ${PRO}`,
      `Switch off payment link ${TEE}`,
    ]);
    expect(JSON.stringify(cards().find((c) => c.title.endsWith(TEE))?.state)).toContain(
      "each order paid through it still goes to Printful",
    );
    expect(roomSays()).toContain(
      `🧪 Test payment link "Sandbox plan" (https://buy.stripe.com/${SANDBOX}) of retired ${side.id} stays on: IdleBiz has no Stripe key.`,
    );
  });

  it("finishes after a restart what a quit cut short, and asks Stripe nothing once it is done", async () => {
    const { side } = openShop();
    // the retirement is on disk, but the app quit before Stripe was asked
    store.killProduct(side.id, "dud", null);
    store.initStore();
    const stripe = fakeStripe();

    await switchOffRetiredLinks();
    await switchOffRetiredLinks();

    expect(stripe.switchOffs.map((s) => s.id)).toEqual([TEE, PRO]);
    expect(statesOf()).toEqual({ [PRO]: "switched-off", [TEE]: "switched-off" });
  });

  it("asks Stripe about a link once even when a pulse sweeps while the retirement does", async () => {
    const { side } = openShop();
    const stripe = fakeStripe();

    await Promise.all([retireProduct(side.id, "dud", null), switchOffRetiredLinks()]);

    expect(stripe.switchOffs.map((s) => s.id)).toEqual([TEE, PRO]);
  });
});

/** Stamp the save as another build would have written it. */
const restamp = (companyId: string, format: number): void => {
  const file = path.join(root, companyId, "COMPANY.md");
  writeFileSync(file, readFileSync(file, "utf-8").replace(/format: \d+/u, `format: ${format}`));
};

/** A format 6 save with a product it already retired and one still live, which made links nobody recorded. */
const olderShop = () => {
  const company = store.foundCompany({
    budget: { mode: "infinite" },
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [],
    mission: "ship",
    name: "Acme",
  });
  const gone = store.createProduct({ description: "a dud", name: "Gone" });
  const side = store.createProduct({ description: "a side bet", name: "Side" });
  store.killProduct(gone.id, "dud", null);
  restamp(company.id, 6);
  store.initStore();
  return { gone, side };
};

describe("an older save's links", () => {
  it("hands the founder the unrecorded links Stripe lists for a retired product, and switches none off", async () => {
    const { gone, side } = olderShop();
    saveKey("rk_live_founder");
    const stripe = fakeStripe({
      active: [
        { id: "plink_old", metadata: { product: gone.id }, url: "https://buy.stripe.com/old" },
        { id: "plink_side", metadata: { product: side.id }, url: "https://buy.stripe.com/side" },
        { id: "plink_mine", metadata: {}, url: "https://buy.stripe.com/mine" },
      ],
    });

    await switchOffRetiredLinks();

    expect(stripe.switchOffs).toEqual([]);
    expect(cards().map((c) => c.title)).toEqual([`Switch off ${gone.id}'s older payment links`]);
    const said = JSON.stringify(cards()[0]?.state);
    expect(said).toContain("https://buy.stripe.com/old (plink_old)");
    expect(said).not.toContain("plink_side");
    expect(store.unrecordedLinkProducts()).not.toContain(gone.id);

    await switchOffRetiredLinks();
    expect(stripe.lists).toBe(1);

    await retireProduct(side.id, "dud too", null);

    expect(stripe.lists).toBe(2);
    expect(cards().map((c) => c.title)).toContain(`Switch off ${side.id}'s older payment links`);
    expect(store.unrecordedLinkProducts()).not.toContain(side.id);
  });

  it("looks for no live product's older links when its PRODUCT.md could not be read", async () => {
    const { side } = olderShop();
    const company = store.getCompany();
    writeFileSync(
      path.join(root, company?.id ?? "", "products", side.id, "PRODUCT.md"),
      "not a product",
    );
    store.initStore();
    saveKey("rk_live_founder");
    fakeStripe({
      active: [
        { id: "plink_side", metadata: { product: side.id }, url: "https://buy.stripe.com/side" },
      ],
    });

    await switchOffRetiredLinks();

    expect(cards().map((c) => c.title)).not.toContain(
      `Switch off ${side.id}'s older payment links`,
    );
    expect(store.unrecordedLinkProducts()).toContain(side.id);
  });

  it("raises nothing for a retired product Stripe lists no link for", async () => {
    olderShop();
    saveKey("rk_live_founder");
    const stripe = fakeStripe();

    await switchOffRetiredLinks();

    expect(stripe.lists).toBe(1);
    expect(cards()).toEqual([]);
  });

  it("waits for a live key before it looks, and looks again after a read that failed", async () => {
    const { gone } = olderShop();
    saveKey("rk_test_founder");
    const stripe = fakeStripe();

    await switchOffRetiredLinks();

    expect(stripe.lists).toBe(0);
    expect(store.unrecordedLinkProducts()).toContain(gone.id);

    saveKey("rk_live_founder");
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    await switchOffRetiredLinks();

    expect(store.unrecordedLinkProducts()).toContain(gone.id);
    expect(cards()).toEqual([]);

    const again = fakeStripe();
    await switchOffRetiredLinks();

    expect(again.lists).toBe(1);
    expect(store.unrecordedLinkProducts()).not.toContain(gone.id);
  });
});

/** A paid print order of `productId`'s tee, at `stage`. */
const teeOrder = (productId: string, id: string, stage: Sale["stage"]): Sale => ({
  collectedCents: 3599,
  costCents: null,
  createdAt: 3,
  email: "buyer@example.com",
  id,
  kind: "sale",
  listingId: "launch-tee",
  livemode: true,
  paymentIntent: null,
  printfulStatus: null,
  productId,
  quantity: 1,
  recipient: {
    address1: "1 Main St",
    address2: null,
    city: "Springfield",
    countryCode: "US",
    name: "Pat Buyer",
    phone: null,
    stateCode: "IL",
    zip: "62701",
  },
  sessionId: `cs_${id}`,
  stage,
  variant: { id: 4012, label: "Black / S" },
});

describe("resetting the company", () => {
  it("switches off every live link still taking money, so nothing charges once the save is gone", async () => {
    const { side } = openShop();
    store.recordChargeLink(chargeLinkOn(side.id, SANDBOX, false));
    const stripe = fakeStripe();

    expect(await switchOffBeforeReset()).toBeNull();

    expect(stripe.switchOffs.map((s) => s.id)).toEqual([TEE, PRO]);
    expect(stripe.switchOffs.every((s) => s.auth === "Bearer rk_live_founder")).toBe(true);
  });

  it("names each link it could not switch off and each paid print not yet at Printful", async () => {
    const { side } = openShop();
    store.recordOrder(teeOrder(side.id, "order-received", { kind: "received", tries: 0 }));
    store.recordOrder(teeOrder(side.id, "order-sent", { kind: "confirmed", printfulId: 7 }));
    const stripe = fakeStripe({ answers: { [PRO]: "refused" } });

    const left = await switchOffBeforeReset();

    expect(stripe.switchOffs.map((s) => s.id)).toEqual([TEE, PRO]);
    expect(left).toContain(`https://buy.stripe.com/${PRO}`);
    expect(left).not.toContain("https://buy.stripe.com/tee");
    expect(left).toContain("Pat Buyer");
    expect(left).not.toContain("order-sent");
  });

  it("names each paid order whose card still waits on the founder, and none they settled", async () => {
    const { side } = openShop();
    const paid = {
      collectedCents: 900,
      createdAt: 3,
      livemode: true,
      paymentIntent: null,
      productId: side.id,
    };
    const owed = (id: string, trouble: string) => {
      store.raiseOrderCard(`Order ${id.slice(0, 8)}: ${trouble}`, {
        action: "Settle it",
        draft: null,
        instructions: "",
        type: "action",
      });
      return `cs_${id}`;
    };
    const delivery = "Email the buyer the PDF";
    store.recordOrder({
      ...paid,
      delivery,
      email: "reader@example.com",
      id: "guide-owed",
      kind: "link",
      name: "Guide",
      sessionId: owed("guide-owed", "deliver it"),
    });
    store.recordOrder({
      ...paid,
      email: null,
      id: "tee-noaddress",
      kind: "unreadable",
      listingId: "launch-tee",
      sessionId: owed("tee-noaddress", "IdleBiz cannot send it"),
      why: "it has no shipping address",
    });
    const settled = owed("guide-sent", "deliver it");
    store.recordOrder({
      ...paid,
      delivery,
      email: "done@example.com",
      id: "guide-sent",
      kind: "link",
      name: "Guide",
      sessionId: settled,
    });
    const card = cards().find((t) => t.title.startsWith("Order guide-se"));
    if (!card) {
      throw new Error("the settled order must have had a card");
    }
    settleOrderCard(card.id, { kind: "done", note: "" });
    fakeStripe();

    const left = await switchOffBeforeReset();

    expect(left).toContain("cs_guide-owed");
    expect(left).toContain("reader@example.com");
    expect(left).toContain(delivery);
    expect(left).toContain("cs_tee-noaddress");
    expect(left).not.toContain(settled);
  });

  it("names a held print only while its card still waits, never one the founder settled", async () => {
    const { side } = openShop();
    const hold = (id: string) => {
      store.recordOrder(
        teeOrder(side.id, id, { kind: "held", printfulId: 7, why: "Printful wants more" }),
      );
      store.raiseOrderCard(`Order ${id.slice(0, 8)}: Printful wants more than the buyer paid`, {
        action: "Settle it",
        draft: null,
        instructions: "",
        type: "action",
      });
    };
    hold("held-open");
    hold("heldover");
    const card = cards().find((t) => t.title.startsWith("Order heldover"));
    if (!card) {
      throw new Error("the settled sale must have had a card");
    }
    settleOrderCard(card.id, { kind: "done", note: "refunded" });
    fakeStripe();

    const left = await switchOffBeforeReset();

    expect(left).toContain("checkout cs_held-open");
    expect(left).not.toContain("cs_heldover");
  });

  it("names every live link for the founder to switch off when IdleBiz holds no key", async () => {
    openShop();
    saveKey(null);
    const stripe = fakeStripe();

    const left = await switchOffBeforeReset();

    expect(stripe.switchOffs).toEqual([]);
    expect(left).toContain("https://buy.stripe.com/tee");
    expect(left).toContain(`https://buy.stripe.com/${PRO}`);
  });
});
