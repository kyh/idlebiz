import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Listing } from "../listing";
import * as store from "./store";
import { alumniDir, companyDir, retiredDir } from "../paths";
import { foundAcme, freshSave } from "../test-support/save";
import { firstProduct, launch, recruit } from "../test-support/store";

freshSave();

const listingOf = (productId: string, id: string): Listing => ({
  betId: null,
  costCents: 1820,
  createdAt: 1,
  id,
  livemode: false,
  name: "Launch tee",
  paymentLink: { id: "plink_1", state: { kind: "selling" }, url: "https://buy.stripe.com/tee" },
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

describe("listings", () => {
  it("gives a namesake on any product the next id, and loads each back", () => {
    foundAcme();
    const first = firstProduct();
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const id = store.newListingId("Launch tee");
    store.recordListing(listingOf(first.id, id));
    expect(store.newListingId("Launch tee")).toBe(`${id}-2`);
    store.recordListing(listingOf(side.id, `${id}-2`));
    expect(() => store.recordListing(listingOf(side.id, id))).toThrow("already kept");

    store.initStore();

    expect(store.listListings().map((l) => [l.productId, l.id])).toEqual([
      [first.id, id],
      [side.id, `${id}-2`],
    ]);
  });

  it("holds an id it handed out until the listing is kept or let go, so two listings never share one", () => {
    foundAcme();
    const first = firstProduct();
    const id = store.newListingId("Launch tee");
    expect(store.newListingId("Launch tee")).toBe(`${id}-2`);
    store.releaseListingId(`${id}-2`);
    store.recordListing(listingOf(first.id, id));
    store.releaseListingId(id);

    expect(store.newListingId("Launch tee")).toBe(`${id}-2`);
  });

  it("skips a listing file it cannot read, and keeps a retired product's, whose orders still ship", () => {
    foundAcme();
    firstProduct();
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    store.recordListing(listingOf(side.id, "launch-tee"));
    const broken = path.join(companyDir(), "listings", "broken.json");
    writeFileSync(broken, "{");

    expect(store.initStore().skipped).toMatchObject([{ kind: "listing", path: broken }]);
    store.killProduct(side.id, "dud", null);
    store.initStore();

    expect(store.listListings()).toMatchObject([{ id: "launch-tee", productId: side.id }]);
  });
});

const saleOf = (productId: string, id: string) =>
  ({
    collectedCents: 3599,
    costCents: null,
    createdAt: 2,
    email: null,
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
      name: "Ada Buyer",
      phone: null,
      stateCode: "IL",
      zip: "62701",
    },
    sessionId: `cs_${id}`,
    stage: { kind: "received", tries: 0 },
    variant: { id: 4012, label: "Black / S" },
  }) as const;

describe("orders", () => {
  it("keeps each order of a kept listing across a restart and past its product's retirement", () => {
    foundAcme();
    const first = firstProduct();
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    expect(() => store.recordOrder(saleOf(first.id, "order-a"))).toThrow("no listing");
    store.recordListing(listingOf(first.id, "launch-tee"));
    store.recordListing(listingOf(side.id, "side-tee"));
    store.recordOrder(saleOf(first.id, "order-a"));
    store.recordOrder({ ...saleOf(side.id, "order-b"), listingId: "side-tee" });
    store.updateSale("order-a", { stage: { checks: 0, kind: "pricing", printfulId: 9001 } });
    expect(() => store.recordOrder(saleOf(first.id, "order-a"))).toThrow("already kept");
    const broken = path.join(companyDir(), "orders", "broken.json");
    writeFileSync(broken, "{");

    expect(store.initStore().skipped).toMatchObject([{ kind: "order", path: broken }]);
    expect(store.listOrders()).toMatchObject([
      { id: "order-a", stage: { kind: "pricing", printfulId: 9001 } },
      { id: "order-b" },
    ]);
    store.killProduct(side.id, "dud", null);
    store.updateSale("order-b", { printfulStatus: "pending" });
    store.initStore();
    expect(store.listOrders()).toMatchObject([
      { id: "order-a" },
      { id: "order-b", printfulStatus: "pending" },
    ]);
  });

  it("raises one card per subject, which no teammate can claim and only the founder settles", () => {
    foundAcme();
    const hired = store.createEmployee(recruit("Priya"));
    const ask = { action: "Settle it", draft: null, instructions: "why", type: "action" } as const;
    const subject = { kind: "order", orderId: "order-1", trouble: "trouble" } as const;
    const card = store.raiseOrderCard(subject, "Order 1: trouble", ask);
    expect(store.raiseOrderCard(subject, "Order order-1 is in trouble", ask)).toBeNull();
    expect(card).toMatchObject({ assigneeId: null, origin: "order", productId: null, subject });
    expect(store.claimTask(card?.id ?? "", hired.id)).toBeNull();
    store.initStore();
    expect(store.listOpenTasks()).toMatchObject([
      { origin: "order", state: { ask, kind: "blocked" }, subject },
    ]);
    expect(
      store.raiseOrderCard({ ...subject, trouble: "more" }, "Order 1: trouble", ask),
    ).toMatchObject({ subject: { trouble: "more" } });

    expect(store.closeOrderCard(card?.id ?? "")).toMatchObject({
      state: { kind: "settled" },
      subject,
    });
    expect(store.listOpenTasks()).toHaveLength(1);
    expect(store.raiseOrderCard(subject, "Order 1: trouble", ask)).not.toBeNull();
  });
});

describe("archives", () => {
  it("keep a released employee's slug, so a namesake's release sticks across a restart", () => {
    foundAcme();
    const first = store.createEmployee(recruit("Priya"));
    store.archiveEmployee(first.id);
    const second = store.createEmployee(recruit("Priya"));
    expect(second.id).toBe(`${first.id}-2`);
    store.archiveEmployee(second.id);
    store.initStore();
    expect(store.listEmployees()).toEqual([]);
    expect(existsSync(path.join(alumniDir(), first.id, "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(alumniDir(), second.id, "AGENTS.md"))).toBe(true);
  });

  it("hand a namesake the next number after every one archived", () => {
    foundAcme();
    for (const slug of ["priya", "priya-2"]) {
      const emp = store.createEmployee(recruit("Priya"));
      expect(emp.id).toBe(slug);
      store.archiveEmployee(emp.id);
    }
    expect(store.createEmployee(recruit("Priya")).id).toBe("priya-3");
  });

  it("keep an id past the slug length whole, so no namesake is handed it again", () => {
    foundAcme();
    const name = "A product whose name runs well past the slug length";
    const kept = store.createProduct({ description: "the first", name });
    const retired = store.createProduct({ description: "the second", name });
    expect(retired.id).toBe(`${kept.id}-2`);
    store.killProduct(retired.id, "dud", null);
    expect(existsSync(path.join(retiredDir(), retired.id, "PRODUCT.md"))).toBe(true);
    expect(store.createProduct({ description: "the third", name }).id).toBe(`${kept.id}-3`);
  });

  it("keep a retired product's slug, so a namesake's retirement sticks across a restart", () => {
    foundAcme();
    const first = firstProduct();
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    store.killProduct(side.id, "dud", null);
    const again = store.createProduct({ description: "a second try", name: "Side" });
    expect(again.id).toBe(`${side.id}-2`);
    store.killProduct(again.id, "dud again", null);
    store.initStore();
    expect(store.listProducts().map((p) => p.id)).toEqual([first.id]);
    expect(existsSync(path.join(retiredDir(), side.id, "PRODUCT.md"))).toBe(true);
    expect(existsSync(path.join(retiredDir(), again.id, "PRODUCT.md"))).toBe(true);
  });

  it("archive beside a namesake a save already holds, so the release sticks across a restart", () => {
    foundAcme();
    const first = firstProduct();
    const emp = store.createEmployee(recruit("Priya"));
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const earlier = [path.join(alumniDir(), emp.id), path.join(retiredDir(), side.id)];
    for (const taken of earlier) {
      mkdirSync(taken, { recursive: true });
      writeFileSync(path.join(taken, "README.md"), "someone else's");
    }
    store.archiveEmployee(emp.id);
    store.killProduct(side.id, "dud", null);
    store.initStore();
    expect(store.listEmployees()).toEqual([]);
    expect(store.listProducts().map((p) => p.id)).toEqual([first.id]);
    expect(existsSync(path.join(alumniDir(), `${emp.id}-2`, "AGENTS.md"))).toBe(true);
    expect(existsSync(path.join(retiredDir(), `${side.id}-2`, "PRODUCT.md"))).toBe(true);
    for (const taken of earlier) {
      expect(readFileSync(path.join(taken, "README.md"), "utf-8")).toBe("someone else's");
    }
  });

  it("refuse a release or a retirement the move cannot make, and nothing leaves", () => {
    foundAcme();
    const emp = store.createEmployee(recruit("Priya"));
    const task = store.createTask({ assigneeId: emp.id, origin: "founder", title: "Ship it" });
    const side = store.createProduct({ description: "a side bet", name: "Side" });
    const bet = launch(side.id);
    for (const archive of [alumniDir(), retiredDir()]) {
      writeFileSync(archive, "not a directory");
    }
    expect(() => store.archiveEmployee(emp.id)).toThrow();
    expect(() => store.killProduct(side.id, "dud", null)).toThrow();
    expect(store.listEmployees().map((e) => e.id)).toEqual([emp.id]);
    expect(store.getTask(task.id)?.assigneeId).toBe(emp.id);
    expect(store.getProduct(side.id)).not.toBeNull();
    expect(store.getBet(bet.id)?.state.kind).toBe("open");
  });
});
