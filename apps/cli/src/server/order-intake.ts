import { createHash } from "node:crypto";
import * as store from "./store/store";
import { postToRoom, raiseOrderCard } from "./company-actions";
import { report } from "./lib/report";
import { VARIANT_FIELD } from "./stripe-links";
import { STRIPE_SECRET_KEY, getSecret } from "./secrets";
import { isTestKey } from "./stripe-api";
import { CHECKOUT_READ_LIMIT, readCheckouts } from "./stripe-checkouts";
import type { CheckoutSession } from "./stripe-checkouts";
import type { OrdersCursor } from "./store/store";
import { formatCents } from "@repo/domain/format";
import type { Listing } from "./listing";
import { orderIdOf } from "./order";
import type { Order, Recipient } from "./order";
import type { LinkState } from "./link-record";
import { REFUND, describe } from "./order-card";

// Each paid checkout on the company's links kept as an order, as docs/keys.md's "The order
// pump" describes.

// Stripe's reads are allotted by sales (on average 500 a transaction over 30 days, at least
// 10k a month), and metrics already spends most of a quiet store's: checkouts are read on a
// slower beat than Printful, which allows far more.
/** How often Stripe's checkouts are read for new paid orders. */
export const CHECKOUTS_READ_MS = 30 * 60_000;

// Each read starts this far behind the last one, so a checkout Stripe lists a moment late is
// still read; one read twice is already kept.
const OVERLAP_S = 10 * 60;
// An unpaid completed checkout is one whose payment (a bank debit) may still land: the cursor
// waits for it this long.
const UNPAID_WAIT_MS = 7 * 24 * 3_600_000;

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
  const chosen = session.custom_fields?.find((field) => field.key === VARIANT_FIELD)?.dropdown
    ?.value;
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

/** What every kept checkout records: who paid how much, and where to find it in Stripe. */
const paidOn = (session: CheckoutSession, productId: string) => ({
  collectedCents: session.amount_total ?? 0,
  createdAt: session.created * 1000,
  email: session.customer_details?.email ?? null,
  id: orderIdOf(session.id),
  livemode: session.livemode,
  paymentIntent: session.payment_intent ?? null,
  productId,
  sessionId: session.id,
});

/**
 * Keep a paid checkout IdleBiz cannot send, and hand it to the founder: the card is raised
 * first, since cards dedupe by subject and the kept order is what stops the next read retrying.
 */
const keepUnreadable = (
  session: CheckoutSession,
  productId: string,
  listingId: string,
  why: string,
): void => {
  const order: Order = { ...paidOn(session, productId), kind: "unreadable", listingId, why };
  if (order.livemode) {
    raiseOrderCard(
      { kind: "order", orderId: order.id, trouble: "IdleBiz cannot send it" },
      {
        action: `Settle ${describe(order)}`,
        draft: null,
        instructions: `A buyer paid, but ${why}, so IdleBiz sent nothing to Printful. Place it by hand in Printful's dashboard if you can. ${REFUND}`,
      },
    );
  }
  store.recordOrder(order);
  if (!order.livemode) {
    postToRoom(
      { kind: "office" },
      `🧪 Test order ${order.id.slice(0, 8)} on ${productId} was not sent to Printful: ${why}.`,
    );
  }
};

/** A checkout opened before its link was switched off still pays, so the room hears that one is on its way. */
const sinceOff = (state: LinkState): string =>
  state.kind === "switched-off" ? ", paid on a link since switched off" : "";

/** Keep a paid checkout on a listing's link as an order, and tell the room: the first sale is the game's milestone. */
const take = (session: CheckoutSession, listing: Listing): void => {
  const read = saleOf(session, listing);
  if (read.kind === "unreadable") {
    keepUnreadable(session, listing.productId, listing.id, read.why);
    return;
  }
  const paid = { ...paidOn(session, listing.productId), listingId: listing.id };
  const { kind, ...sold } = read;
  store.recordOrder({
    ...paid,
    ...sold,
    costCents: null,
    kind,
    printfulStatus: null,
    stage: { kind: "received", tries: 0 },
  });
  const test = session.livemode
    ? ""
    : " (test mode: Printful only prices a draft, then it is deleted)";
  postToRoom(
    { kind: "office" },
    `📦 Sold ${listing.name} (${read.variant.label}) for ${formatCents(paid.collectedCents)} on ${listing.productId}${sinceOff(listing.paymentLink.state)}: it goes to Printful now${test}.`,
  );
};

/**
 * Keep a paid checkout on a create_payment_link link, tell the room, and card the founder with
 * what the link says to deliver: nothing reaches a buyer from the team. The card is raised
 * before the order is kept, as in keepUnreadable.
 */
const takeLinkSale = (session: CheckoutSession, productId: string): void => {
  const order: Order = {
    ...paidOn(session, productId),
    delivery: session.metadata?.delivery ?? null,
    kind: "link",
    name: session.line_items?.data[0]?.description ?? "a payment link's item",
  };
  if (order.livemode && order.delivery !== null) {
    raiseOrderCard(
      { kind: "order", orderId: order.id, trouble: "deliver it" },
      {
        action: `Send ${order.email ?? "the buyer"} what ${JSON.stringify(order.name)} promised`,
        draft: null,
        instructions: `${describe(order)}. The team says to send: ${order.delivery} Press Done once it is sent. If you can't deliver it, refund the buyer in Stripe.`,
      },
    );
  }
  store.recordOrder(order);
  const link = store.getChargeLink(session.payment_link ?? "");
  const sold = `💵 Sold ${JSON.stringify(order.name)} for ${formatCents(order.collectedCents)} on ${productId}${link === null ? "" : sinceOff(link.state)}`;
  if (!order.livemode) {
    postToRoom({ kind: "office" }, `${sold} (test mode: nobody paid).`);
    return;
  }
  postToRoom(
    { kind: "office" },
    order.delivery === null ? `${sold}.` : `${sold}: the founder delivers it.`,
  );
};

/** Which of the company's links a checkout was made on, or null for any other checkout on the account. */
type SoldOn =
  | { kind: "listing"; listing: Listing }
  /** A listing's link whose listing this save no longer holds: paid, with nothing to print from. */
  | { kind: "lost"; productId: string; listingId: string }
  | { kind: "link"; productId: string };

/** A link is the company's when it is a listing's, or its `product` tag names a product the company made. */
const soldOn = (session: CheckoutSession, onLink: ReadonlyMap<string, Listing>): SoldOn | null => {
  const listing = onLink.get(session.payment_link ?? "");
  if (listing !== undefined) {
    return { kind: "listing", listing };
  }
  const tags = session.metadata;
  const productId = tags?.product;
  if (!session.payment_link || !productId || !store.madeProduct(productId)) {
    return null;
  }
  return tags.listing === undefined
    ? { kind: "link", productId }
    : { kind: "lost", listingId: tags.listing, productId };
};

const keep = (session: CheckoutSession, sold: SoldOn): void => {
  switch (sold.kind) {
    case "listing": {
      take(session, sold.listing);
      return;
    }
    case "lost": {
      keepUnreadable(
        session,
        sold.productId,
        sold.listingId,
        `IdleBiz no longer holds the listing ${sold.listingId} it was bought from`,
      );
      return;
    }
    case "link": {
      takeLinkSale(session, sold.productId);
    }
    // no default
  }
};

/**
 * Which key reads, as the cursor keeps it: its mode, and a digest that tells keys apart without
 * holding one, since the save is read by every run.
 */
const readerOf = (key: string): string =>
  `${isTestKey(key) ? "test" : "live"}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

/**
 * Where a key's read goes on from: its own last read. A key that never read, in a mode another
 * has (a rolled key, another account), starts from the oldest of that mode's reads; one of a
 * mode never read starts from `foundedAt`. Whichever key read last, no key skips what it never read.
 */
const startOf = (cursor: OrdersCursor, reader: string, foundedAt: number): number => {
  const own = cursor.byKey[reader];
  if (own !== undefined) {
    return own;
  }
  const mode = `${reader.split(":")[0]}:`;
  const sameMode = Object.entries(cursor.byKey)
    .filter(([other]) => other.startsWith(mode))
    .map(([, at]) => at);
  return sameMode.length > 0 ? Math.min(...sameMode) : foundedAt;
};

const stillSelling = (state: LinkState): boolean => state.kind !== "switched-off";

/**
 * The founder's card while no live key reads what a live link still sells: a print, or a
 * delivery. Removing the key or saving a test one switches off no link.
 */
const cardUnlessLive = (key: string | null): void => {
  if (key !== null && !isTestKey(key)) {
    return;
  }
  const owed =
    store.listListings().some((l) => l.livemode && stillSelling(l.paymentLink.state)) ||
    store
      .listChargeLinks()
      .some((link) => link.livemode && link.delivery !== null && stillSelling(link.state));
  if (!owed) {
    return;
  }
  const why = key === null ? "no Stripe key is saved" : "the saved Stripe key is a test key";
  raiseOrderCard(
    { kind: "pump", reason: "no-live-key" },
    {
      action: "Save a live Stripe key in the Budget panel",
      draft: null,
      instructions: `IdleBiz reads paid orders with the Stripe key in the Budget panel, and ${why}, while the company's live payment links still take real money. Nobody's paid print reaches Printful and no card tells you what a buyer is owed until a live key whose restricted permissions include Read on Checkout Sessions, or your secret key, is saved. Press Done once it is saved: the orders paid meanwhile are read then.`,
    },
  );
};

/**
 * Keep every paid checkout on the company's links since the key's cursor, and move it up to the
 * oldest that may still be paid: an open one (Stripe expires those within a day), or one whose
 * payment is still on its way.
 */
export const takePaidCheckouts = async (now: number): Promise<void> => {
  const key = getSecret(STRIPE_SECRET_KEY);
  cardUnlessLive(key);
  if (key === null) {
    return;
  }
  const cursor = store.ordersCursor() ?? { byKey: {} };
  const reader = readerOf(key);
  const from = startOf(cursor, reader, Math.floor(store.requireCompany().createdAt / 1000) - 1);
  const moveTo = (next: number): void => {
    store.setOrdersCursor({
      ...cursor,
      byKey: { ...cursor.byKey, [reader]: Math.max(from, next) },
    });
  };
  const read = await readCheckouts(key, from);
  if (read.kind === "refused") {
    // Only what can be owed wants a read: a print, a kept order, or a live link's delivery. The
    // grant is checked as a delivery link is made, but a key saved since may lack it.
    const owed =
      store.listListings().length > 0 ||
      store.listOrders().length > 0 ||
      store.listChargeLinks().some((link) => link.livemode && link.delivery !== null);
    if (!owed) {
      return;
    }
    raiseOrderCard(
      { kind: "pump", reason: "unreadable-checkouts" },
      {
        action: "Let IdleBiz's Stripe key read checkouts",
        draft: null,
        instructions: `Stripe turned IdleBiz's key away when it read checkout sessions (${read.reason}), so no paid print reaches Printful and no card tells you what a buyer is owed. In the Budget panel, paste over it a key whose restricted permissions include Read on Checkout Sessions, or your secret key. Press Done once it is saved: the waiting orders go out on their own.`,
      },
    );
    return;
  }
  if (read.kind === "failed") {
    report("orders", new Error(`Stripe's checkouts could not be read: ${read.reason}`));
    return;
  }
  const onLink = new Map(store.listListings().map((l) => [l.paymentLink.id, l]));
  const kept = new Set(store.listOrders().map((o) => o.sessionId));
  let waitFrom = Math.floor(now / 1000) - OVERLAP_S;
  for (const session of read.sessions) {
    const sold = soldOn(session, onLink);
    if (sold === null || kept.has(session.id)) {
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
        keep(session, sold);
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
    moveTo(waitFrom);
    return;
  }
  // Stripe lists newest first, so the older ones are out of reach of every read to come: the
  // founder is told, and the cursor moves up to what was read, or no read would ever catch up.
  const oldestRead = Math.min(...read.sessions.map((session) => session.created));
  moveTo(Math.min(waitFrom, oldestRead - 1));
  raiseOrderCard(
    { kind: "pump", reason: "missed" },
    {
      action: "Check Stripe for payments on IdleBiz's payment links",
      draft: null,
      instructions: `More checkouts reached Stripe between two of IdleBiz's reads than one read takes (${CHECKOUT_READ_LIMIT}), which other business on the same account causes, so IdleBiz read only the newest and skipped any made before ${new Date(oldestRead * 1000).toISOString()}. In Stripe's dashboard, look for payments on IdleBiz's payment links before then that no order card or read_orders shows: place a print in Printful by hand, and deliver anything else. ${REFUND}`,
    },
  );
};
