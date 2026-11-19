import { unreachable } from "@repo/domain/errors";
import { createHash } from "node:crypto";
import * as store from "./store/store";
import { postToRoom, raiseOrderCard } from "./company-actions";
import { report } from "./lib/report";
import { VARIANT_FIELD } from "./stripe-links";
import { STRIPE_SECRET_KEY } from "./vault/names";
import { getSecret } from "./vault/vault";
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

/** How often Stripe's checkouts are read for new paid orders. */
export const CHECKOUTS_READ_MS = 30 * 60_000;

const OVERLAP_S = 10 * 60;
const UNPAID_WAIT_MS = 7 * 24 * 3_600_000;

const recipientOf = (session: CheckoutSession) => {
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
  } satisfies Recipient | null;
};

type Variant = Listing["variants"][number];

const saleOf = (session: CheckoutSession, listing: Listing) => {
  if (session.currency !== "usd" || session.amount_total === null) {
    return {
      kind: "unreadable",
      why: `Stripe collected it in ${session.currency ?? "no currency"}, not USD`,
    } satisfies
      | { kind: "sale"; recipient: Recipient; variant: Variant; quantity: number }
      | { kind: "unreadable"; why: string };
  }

  const recipient = recipientOf(session);

  if (recipient === null) {
    return {
      kind: "unreadable",
      why: "Stripe's checkout carries no whole US shipping address",
    } satisfies
      | { kind: "sale"; recipient: Recipient; variant: Variant; quantity: number }
      | { kind: "unreadable"; why: string };
  }

  const chosen = session.custom_fields?.find((field) => field.key === VARIANT_FIELD)?.dropdown
    ?.value;

  const [only] = listing.variants;

  const variant =
    listing.variants.length === 1 ? only : listing.variants.find((v) => String(v.id) === chosen);

  if (variant === undefined) {
    return {
      kind: "unreadable",
      why: "the buyer's option names none of the listing's variants",
    } satisfies
      | { kind: "sale"; recipient: Recipient; variant: Variant; quantity: number }
      | { kind: "unreadable"; why: string };
  }

  return {
    kind: "sale",
    quantity: session.line_items?.data[0]?.quantity ?? 1,
    recipient,
    variant,
  } satisfies
    | { kind: "sale"; recipient: Recipient; variant: Variant; quantity: number }
    | { kind: "unreadable"; why: string };
};

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

const keepUnreadable = (
  session: CheckoutSession,
  productId: string,
  listingId: string,
  why: string,
) => {
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

const sinceOff = (state: LinkState) =>
  state.kind === "switched-off" ? ", paid on a link since switched off" : "";

const take = (session: CheckoutSession, listing: Listing) => {
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

const takeLinkSale = (session: CheckoutSession, productId: string) => {
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

type SoldOn =
  | { kind: "listing"; listing: Listing }
  | { kind: "lost"; productId: string; listingId: string }
  | { kind: "link"; productId: string };

const soldOn = (session: CheckoutSession, onLink: ReadonlyMap<string, Listing>) => {
  const listing = onLink.get(session.payment_link ?? "");

  if (listing !== undefined) {
    return { kind: "listing", listing } satisfies SoldOn | null;
  }

  const tags = session.metadata;
  const productId = tags?.product;

  if (!session.payment_link || !productId || !store.madeProduct(productId)) {
    return null;
  }

  return (
    tags.listing === undefined
      ? { kind: "link", productId }
      : { kind: "lost", listingId: tags.listing, productId }
  ) satisfies SoldOn | null;
};

const keep = (session: CheckoutSession, sold: SoldOn) => {
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

      return;
    }

    default: {
      return unreachable(sold);
    }
  }
};

const readerOf = (key: string) =>
  `${isTestKey(key) ? "test" : "live"}:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

const startOf = (cursor: OrdersCursor, reader: string, foundedAt: number) => {
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

const stillSelling = (state: LinkState) => state.kind !== "switched-off";

const cardUnlessLive = (key: string | null) => {
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
export const takePaidCheckouts = async (now: number) => {
  const key = getSecret(STRIPE_SECRET_KEY);
  cardUnlessLive(key);

  if (key === null) {
    return;
  }

  const cursor = store.ordersCursor() ?? { byKey: {} };
  const reader = readerOf(key);
  const from = startOf(cursor, reader, Math.floor(store.requireCompany().createdAt / 1000) - 1);

  const moveTo = (next: number) => {
    store.setOrdersCursor({
      ...cursor,
      byKey: { ...cursor.byKey, [reader]: Math.max(from, next) },
    });
  };

  const read = await readCheckouts(key, from);

  if (read.kind === "refused") {
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
