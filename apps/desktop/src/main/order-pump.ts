import { createHash } from "node:crypto";
import * as store from "@/main/store/store";
import { postToRoom, raiseOrderCard } from "@/main/company-actions";
import { report } from "@/main/lib/report";
import { readPrintFile } from "@/main/print-listing";
import { printfulCredential } from "@/main/printful";
import type { PrintfulCredential } from "@/main/printful";
import { printfulOrders } from "@/main/printful-orders";
import type { PrintfulOrder } from "@/main/printful-orders";
import { STRIPE_SECRET_KEY, getSecret } from "@/main/secrets";
import { readCheckouts } from "@/main/stripe-checkouts";
import type { CheckoutSession } from "@/main/stripe-checkouts";
import { formatUsd } from "@/shared/format";
import type { Listing } from "@/shared/listing";
import type { Order, Recipient, Sale } from "@/shared/order";

// Each paid checkout on a listing's payment link becomes one Printful order, placed with the
// founder's token here in main. The order is on disk before Printful hears of it, and its
// external id is the checkout's hash, so a restart looks it up rather than make it twice. A
// draft charges nothing; it is confirmed only on a read that shows it still a draft, priced
// at no more than the buyer paid, so no restart confirms one twice or over that guard.
// Whatever the pump cannot settle goes to the founder as a card: refunds are theirs.

/** How often Stripe's checkouts are read, and sent orders' statuses with them: Printful takes days to ship. */
export const ORDER_READ_MS = 10 * 60_000;

// failed sends before the founder is asked, a read apart each (an hour)
const MAX_SEND_TRIES = 6;
// reads of a draft's costs, a pulse apart, before the founder is asked
const MAX_PRICING_CHECKS = 20;
// Each read starts this far behind the last one, so a checkout Stripe lists a moment late is
// still read; one read twice is already kept.
const OVERLAP_S = 10 * 60;
// An unpaid completed checkout is one whose payment (a bank debit) may still land: the cursor
// waits for it this long.
const UNPAID_WAIT_MS = 7 * 24 * 3_600_000;

/** Printful statuses after which nothing changes. */
const SETTLED = new Set(["fulfilled", "canceled", "deleted"]);
/** Printful statuses the founder has to look at. */
const ALARMING = new Set(["failed", "canceled", "onhold"]);

/** Printful's external id for a checkout: its hash, since a session id is longer than the 32 characters Printful keeps. */
export const orderIdOf = (sessionId: string): string =>
  createHash("sha256").update(sessionId).digest("base64url").slice(0, 32);

const cents = (amount: number): string => formatUsd(amount / 100);

const listingOf = (order: Order): Listing | null =>
  store.listListings().find((l) => l.productId === order.productId && l.id === order.listingId) ??
  null;

/** How a card names an order: the buyer, what they bought, and where to find it in Stripe. */
const describe = (order: Order): string => {
  const listing = listingOf(order)?.name ?? order.listingId;
  const who =
    order.kind === "sale"
      ? `${order.recipient.name}'s ${listing} (${order.variant.label})`
      : listing;
  const email = order.email === null ? "" : `, ${order.email}`;
  const payment = order.paymentIntent ?? order.sessionId;
  return `${who}${email}: paid ${cents(order.collectedCents)} on ${order.productId}, Stripe payment ${payment}`;
};

const cardTitle = (order: Order, trouble: string): string =>
  `Order ${order.id.slice(0, 8)}: ${trouble}`;

const REFUND = "If it can't ship, refund the buyer in Stripe.";

/** The founder's card for a sale that goes no further on its own, and the sale held until they settle it. */
const hold = (sale: Sale, printfulId: number | null, trouble: string, why: string): void => {
  store.updateSale(sale.id, { stage: { kind: "held", printfulId, why } });
  const where = printfulId === null ? "" : ` Printful order ${printfulId}.`;
  raiseOrderCard(cardTitle(sale, trouble), {
    action: `Settle ${describe(sale)}`,
    draft: null,
    instructions: `${why}${where} ${REFUND}`,
  });
};

const printfulTokenCard = (): void => {
  raiseOrderCard("Paid orders wait for a Printful token", {
    action: "Paste a new Printful token in the Budget panel",
    draft: null,
    instructions:
      "Printful turned IdleBiz's token away, which happens once one expires, or none is saved, so paid orders cannot reach Printful. Create a private token at developers.printful.com/tokens and paste it in the Budget panel. Press Done once it is saved: the waiting orders go out on their own.",
  });
};

/** A send that failed for now: tried again on the next read, until the founder is asked. */
const failedTry = (sale: Sale, tries: number, reason: string): void => {
  if (tries + 1 < MAX_SEND_TRIES) {
    store.updateSale(sale.id, { stage: { kind: "received", tries: tries + 1 } });
    return;
  }
  hold(
    sale,
    null,
    "IdleBiz could not send it to Printful",
    `IdleBiz tried ${MAX_SEND_TRIES} times to send it to Printful, and nothing was placed: ${reason}. Place it by hand in Printful's dashboard.`,
  );
};

/** Take on what Printful already has for a sale: a draft to price, or one already submitted. */
const adopt = (sale: Sale, order: PrintfulOrder): void => {
  store.updateSale(sale.id, {
    printfulStatus: order.status,
    stage:
      order.status === "draft"
        ? { checks: 0, kind: "pricing", printfulId: order.id }
        : { kind: "confirmed", printfulId: order.id },
  });
};

/**
 * Whether the listing's design is still what the founder signed off, byte for byte: Printful
 * prints whatever its URL serves now. `unread` is a file that did not load, which may pass.
 */
const designCheck = async (
  listing: Listing,
): Promise<
  { kind: "same" } | { kind: "changed"; url: string } | { kind: "unread"; reason: string }
> => {
  for (const { fileUrl, sha256 } of listing.placements) {
    const file = await readPrintFile(fileUrl);
    if (file.kind === "unfit") {
      return { kind: "unread", reason: `${fileUrl} did not load: ${file.reason}` };
    }
    if (file.sha256 !== sha256) {
      return { kind: "changed", url: fileUrl };
    }
  }
  return { kind: "same" };
};

/** Find the draft a run before a restart made, or make it, once the design is still the one signed. */
const send = async (sale: Sale, tries: number, credential: PrintfulCredential): Promise<void> => {
  const listing = listingOf(sale);
  if (listing === null) {
    hold(
      sale,
      null,
      "its listing is gone",
      `IdleBiz no longer has the listing ${sale.listingId} this was bought from, so it knows no design to print.`,
    );
    return;
  }
  const found = await printfulOrders.lookup(sale.id, credential);
  if (found.kind === "ok") {
    adopt(sale, found.value);
    return;
  }
  if (found.kind === "refused") {
    printfulTokenCard();
    return;
  }
  if (found.kind !== "missing") {
    failedTry(sale, tries, found.reason);
    return;
  }
  const design = await designCheck(listing);
  if (design.kind === "unread") {
    failedTry(sale, tries, design.reason);
    return;
  }
  if (design.kind === "changed") {
    hold(
      sale,
      null,
      "its design changed",
      `${design.url} no longer serves the design you signed off, so IdleBiz sent nothing to Printful. Place it by hand with the design they bought.`,
    );
    return;
  }
  const made = await printfulOrders.create(
    {
      email: sale.email,
      externalId: sale.id,
      name: listing.name,
      placements: listing.placements,
      quantity: sale.quantity,
      recipient: sale.recipient,
      retailCents: listing.priceCents,
      retailShippingCents: listing.shippingCents,
      variantId: sale.variant.id,
    },
    credential,
  );
  switch (made.kind) {
    case "ok": {
      adopt(sale, made.value);
      return;
    }
    case "refused": {
      printfulTokenCard();
      return;
    }
    case "rejected": {
      hold(
        sale,
        null,
        "Printful would not take it",
        `Printful would not take the order: ${made.reason}. Place it by hand in Printful's dashboard if you can.`,
      );
      return;
    }
    case "missing": {
      failedTry(sale, tries, "Printful answered 404");
      return;
    }
    case "down": {
      failedTry(sale, tries, made.reason);
    }
    // no default
  }
};

/** A draft still being priced: read again on the next pulse, until the founder is asked. */
const recheck = (sale: Sale, printfulId: number, checks: number, reason: string): void => {
  if (checks + 1 < MAX_PRICING_CHECKS) {
    store.updateSale(sale.id, { stage: { checks: checks + 1, kind: "pricing", printfulId } });
    return;
  }
  hold(
    sale,
    printfulId,
    "Printful has not priced it",
    `Printful's draft is still unpriced after ${MAX_PRICING_CHECKS} reads (${reason}), so IdleBiz has not confirmed it. Check its cost in Printful's dashboard and confirm it there if it is no more than the buyer paid.`,
  );
};

/** Confirm a priced draft, on this read that shows it a draft, only when it costs no more than the buyer paid. */
const confirm = async (
  sale: Sale,
  order: PrintfulOrder,
  checks: number,
  credential: PrintfulCredential,
): Promise<void> => {
  const { costs } = order;
  if (costs.kind === "calculating") {
    recheck(sale, order.id, checks, "Printful is still working out its cost");
    return;
  }
  if (costs.kind === "failed" || costs.currency !== "USD" || costs.totalCents === null) {
    hold(
      sale,
      order.id,
      "Printful could not price it",
      costs.kind === "done" && costs.currency !== "USD"
        ? `Printful prices the draft in ${costs.currency ?? "no currency"}, and IdleBiz confirms only in USD, so it is still a draft.`
        : "Printful could not work out what the draft costs, which bad art or an address it cannot ship to causes, so it is still a draft. Its dashboard says why.",
    );
    return;
  }
  const costCents = costs.totalCents;
  store.updateSale(sale.id, { costCents });
  if (costCents > sale.collectedCents) {
    hold(
      sale,
      order.id,
      "Printful wants more than the buyer paid",
      `Printful charges ${cents(costCents)} to print and ship it, and the buyer paid ${cents(sale.collectedCents)}, so IdleBiz left it a draft rather than confirm it at a loss of ${cents(costCents - sale.collectedCents)} before Stripe's fee. Confirm it in Printful's dashboard to ship it anyway, or delete the draft.`,
    );
    return;
  }
  if (!sale.livemode) {
    store.updateSale(sale.id, {
      printfulStatus: "draft",
      stage: { kind: "test", printfulId: order.id },
    });
    return;
  }
  const confirmed = await printfulOrders.confirm(order.id, credential);
  switch (confirmed.kind) {
    case "ok": {
      store.updateSale(sale.id, {
        printfulStatus: confirmed.value.status,
        stage: { kind: "confirmed", printfulId: order.id },
      });
      return;
    }
    case "refused": {
      printfulTokenCard();
      return;
    }
    case "rejected": {
      hold(
        sale,
        order.id,
        "Printful would not confirm it",
        `Printful would not confirm the draft: ${confirmed.reason}.`,
      );
      return;
    }
    // whether it went through, the next read says: a confirmed order is no longer a draft
    case "missing":
    case "down": {
      recheck(sale, order.id, checks, "its confirmation got no answer");
    }
    // no default
  }
};

const price = async (
  sale: Sale,
  printfulId: number,
  checks: number,
  credential: PrintfulCredential,
): Promise<void> => {
  const read = await printfulOrders.read(printfulId, credential);
  switch (read.kind) {
    case "ok": {
      if (read.value.status === "draft") {
        await confirm(sale, read.value, checks, credential);
      } else {
        adopt(sale, read.value);
      }
      return;
    }
    case "refused": {
      printfulTokenCard();
      return;
    }
    case "missing": {
      hold(
        sale,
        null,
        "its draft is gone",
        `Printful no longer has draft ${printfulId}, which someone deleted, so nothing was confirmed.`,
      );
      return;
    }
    case "rejected":
    case "down": {
      recheck(sale, printfulId, checks, read.reason);
    }
    // no default
  }
};

/** Read a submitted order's status, and hand the founder one that went wrong. */
const track = async (
  sale: Sale,
  printfulId: number,
  credential: PrintfulCredential,
): Promise<void> => {
  const read = await printfulOrders.read(printfulId, credential);
  if (read.kind === "refused") {
    printfulTokenCard();
    return;
  }
  if (read.kind !== "ok" && read.kind !== "missing") {
    return;
  }
  const status = read.kind === "ok" ? read.value.status : "deleted";
  if (status === sale.printfulStatus) {
    return;
  }
  store.updateSale(sale.id, { printfulStatus: status });
  // a held draft the founder confirmed by hand is on its way like any other
  if (sale.stage.kind === "held" && status !== "draft" && status !== "deleted") {
    store.updateSale(sale.id, { stage: { kind: "confirmed", printfulId } });
  }
  if (ALARMING.has(status)) {
    raiseOrderCard(cardTitle(sale, `Printful marked it ${status}`), {
      action: `Check ${describe(sale)}`,
      draft: null,
      instructions: `Printful marked order ${printfulId} ${status}. Printful says why only on its dashboard: check it there, and fix what it asks (a failed charge is retried once billing works). ${REFUND}`,
    });
  }
};

/** What a sale does next, if anything now: a draft is priced every pulse, the rest waits for a read. */
const stepOf = (
  sale: Sale,
  readNow: boolean,
): ((credential: PrintfulCredential) => Promise<void>) | null => {
  const { stage } = sale;
  switch (stage.kind) {
    case "pricing": {
      return (credential) => price(sale, stage.printfulId, stage.checks, credential);
    }
    case "received": {
      return readNow ? (credential) => send(sale, stage.tries, credential) : null;
    }
    case "confirmed":
    case "held": {
      const { printfulId } = stage;
      return readNow && printfulId !== null && !SETTLED.has(sale.printfulStatus ?? "")
        ? (credential) => track(sale, printfulId, credential)
        : null;
    }
    case "test": {
      return null;
    }
    // no default
  }
};

/** Where the buyer asked for it to go, or null when Stripe's checkout holds no whole US address. */
const recipientOf = (session: CheckoutSession): Recipient | null => {
  const shipping = session.collected_information?.shipping_details;
  const address = shipping?.address;
  const { city, country, line1, postal_code: zip, state } = address ?? {};
  if (!shipping || !line1 || !city || !state || !zip || country !== "US") {
    return null;
  }
  return {
    address1: line1,
    address2: address?.line2 ?? null,
    city,
    countryCode: country,
    name: shipping.name,
    phone: session.customer_details?.phone ?? null,
    stateCode: state,
    zip,
  };
};

type Variant = Listing["variants"][number];

/** Why a paid checkout is no order IdleBiz can send, or what it orders. */
const saleOf = (
  session: CheckoutSession,
  listing: Listing,
):
  | { kind: "sale"; recipient: Recipient; variant: Variant; quantity: number }
  | { kind: "unreadable"; why: string } => {
  if (session.currency !== "usd" || session.amount_total === null) {
    return {
      kind: "unreadable",
      why: `Stripe collected it in ${session.currency ?? "no currency"}, not USD`,
    };
  }
  const recipient = recipientOf(session);
  if (recipient === null) {
    return { kind: "unreadable", why: "Stripe's checkout carries no whole US shipping address" };
  }
  const chosen = session.custom_fields?.find((field) => field.key === "variant")?.dropdown?.value;
  const [only] = listing.variants;
  const variant =
    listing.variants.length === 1 ? only : listing.variants.find((v) => String(v.id) === chosen);
  if (variant === undefined) {
    return { kind: "unreadable", why: "the buyer's option names none of the listing's variants" };
  }
  return {
    kind: "sale",
    quantity: session.line_items?.data[0]?.quantity ?? 1,
    recipient,
    variant,
  };
};

/** Keep a paid checkout as an order, and tell the room: the first sale is the game's milestone. */
const take = (session: CheckoutSession, listing: Listing): void => {
  const paid = {
    collectedCents: session.amount_total ?? 0,
    createdAt: session.created * 1000,
    email: session.customer_details?.email ?? null,
    id: orderIdOf(session.id),
    listingId: listing.id,
    livemode: session.livemode,
    paymentIntent: session.payment_intent ?? null,
    productId: listing.productId,
    sessionId: session.id,
  };
  const read = saleOf(session, listing);
  if (read.kind === "unreadable") {
    const order: Order = { ...paid, kind: "unreadable", why: read.why };
    store.recordOrder(order);
    raiseOrderCard(cardTitle(order, "IdleBiz cannot send it"), {
      action: `Settle ${describe(order)}`,
      draft: null,
      instructions: `A buyer paid, but ${read.why}, so IdleBiz sent nothing to Printful. Place it by hand in Printful's dashboard if you can. ${REFUND}`,
    });
    return;
  }
  const { kind, ...sold } = read;
  store.recordOrder({
    ...paid,
    ...sold,
    costCents: null,
    kind,
    printfulStatus: null,
    stage: { kind: "received", tries: 0 },
  });
  const test = session.livemode ? "" : " (test mode: Printful gets a draft, never confirmed)";
  postToRoom(
    { kind: "office" },
    `📦 Sold ${listing.name} (${read.variant.label}) for ${cents(paid.collectedCents)} on ${listing.productId}: it goes to Printful now${test}.`,
  );
};

/**
 * Keep every paid checkout on a listing's link since the cursor, and move the cursor up to the
 * oldest that may still be paid: an open one (Stripe expires those within a day), or one whose
 * payment is still on its way.
 */
const takePaidCheckouts = async (now: number): Promise<void> => {
  const listings = store.listListings();
  const key = getSecret(STRIPE_SECRET_KEY);
  if (listings.length === 0 || key === null) {
    return;
  }
  const oldest = Math.min(...listings.map((l) => l.createdAt));
  const cursor = store.ordersCursor() ?? Math.floor(oldest / 1000) - 1;
  const read = await readCheckouts(key, cursor);
  if (read.kind === "refused") {
    raiseOrderCard("Paid orders can't be read from Stripe", {
      action: "Let IdleBiz's Stripe key read checkouts",
      draft: null,
      instructions: `Stripe turned IdleBiz's key away when it read checkout sessions (${read.said}), so no paid print reaches Printful. In the Budget panel, remove the key and paste one whose restricted permissions include Read on Checkout Sessions, or your secret key. Press Done once it is saved: the waiting orders go out on their own.`,
    });
    return;
  }
  if (read.kind === "failed") {
    report("orders", new Error(`Stripe's checkouts could not be read: ${read.reason}`));
    return;
  }
  const onLink = new Map(listings.map((l) => [l.paymentLink.id, l]));
  const kept = new Set(store.listOrders().map((o) => o.sessionId));
  let waitFrom = Math.floor(now / 1000) - OVERLAP_S;
  for (const session of read.sessions) {
    const listing = onLink.get(session.payment_link ?? "");
    if (listing === undefined || kept.has(session.id)) {
      continue;
    }
    const mayPay =
      session.status === "open" ||
      (session.status === "complete" &&
        session.payment_status === "unpaid" &&
        now - session.created * 1000 < UNPAID_WAIT_MS);
    let unkept = false;
    if (session.payment_status === "paid") {
      try {
        take(session, listing);
      } catch (error) {
        report(`order ${session.id}`, error);
        unkept = true;
      }
    }
    if (mayPay || unkept) {
      waitFrom = Math.min(waitFrom, session.created - 1);
    }
    kept.add(session.id);
  }
  if (read.whole) {
    store.setOrdersCursor(Math.max(cursor, waitFrom));
  } else {
    report("orders", new Error("more checkouts since the last read than one read takes"));
  }
};

/**
 * Carry every order a step: on a read (`readNow`), take new paid checkouts from Stripe, send
 * what waits and read sent orders' statuses; on every pulse, price and confirm drafts. One
 * order's fault is its own.
 */
export const pumpOrders = async (now: number, readNow: boolean): Promise<void> => {
  if (store.getCompany() === null) {
    return;
  }
  if (readNow) {
    await takePaidCheckouts(now);
  }
  const credential = printfulCredential();
  for (const order of store.listOrders()) {
    if (order.kind !== "sale") {
      continue;
    }
    const step = stepOf(order, readNow);
    if (step === null) {
      continue;
    }
    if (credential === null) {
      printfulTokenCard();
      continue;
    }
    try {
      await step(credential);
    } catch (error) {
      report(`order ${order.id}`, error);
    }
  }
};
