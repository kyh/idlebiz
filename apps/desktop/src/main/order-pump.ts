import { createHash } from "node:crypto";
import * as store from "@/main/store/store";
import { postToRoom, raiseOrderCard } from "@/main/company-actions";
import { report } from "@/main/lib/report";
import { VARIANT_FIELD } from "@/main/payment-links";
import { STRIPE_FEE_LABEL, netOfStripeCents, readPrintFile } from "@/main/print-listing";
import { printfulCredential } from "@/main/printful";
import type { PrintfulCredential } from "@/main/printful";
import { printfulOrders } from "@/main/printful-orders";
import type { PrintfulOrder } from "@/main/printful-orders";
import { STRIPE_SECRET_KEY, getSecret } from "@/main/secrets";
import { isTestKey } from "@/main/stripe-api";
import { CHECKOUT_READ_LIMIT, readCheckouts, readPaymentStanding } from "@/main/stripe-checkouts";
import type { CheckoutSession, PaymentStanding } from "@/main/stripe-checkouts";
import type { OrdersCursor } from "@/main/store/store";
import { formatCents } from "@/shared/format";
import type { Listing } from "@/shared/listing";
import type { Order, Recipient, Sale } from "@/shared/order";
import type { LinkState } from "@/shared/payment-link";

// Each paid checkout on a listing's payment link becomes one Printful order, placed with the
// founder's token here in main. The order is on disk before Printful hears of it, and its
// external id is the checkout's hash, so a restart looks it up rather than make it twice. A
// draft charges nothing; it is confirmed only on a read that shows it still a draft, priced at
// no more than the buyer paid less Stripe's fee on a card, with the payment made by card and
// neither refunded nor disputed, so no restart confirms one twice or past that guard.
// Whatever the pump cannot settle goes to the founder as a card: refunds are theirs. A paid
// checkout on a create_payment_link link ships nothing, so it is kept too, and one whose link
// names a delivery is carded to the founder, who alone can reach the buyer.

// Stripe's reads are allotted by sales (on average 500 a transaction over 30 days, at least
// 10k a month), and metrics already spends most of a quiet store's: checkouts are read on a
// slower beat than Printful, which allows far more.
/** How often Stripe's checkouts are read for new paid orders. */
export const CHECKOUTS_READ_MS = 30 * 60_000;
/** How often waiting orders are sent and sent ones' statuses read: Printful takes days to ship. */
export const ORDER_TRACK_MS = 10 * 60_000;

/**
 * What a pulse does for orders: `read` takes new paid checkouts from Stripe, then does what
 * `track` does; `track` sends what waits and reads sent orders' statuses; every beat prices
 * and confirms drafts.
 */
export type OrderBeat = "read" | "track" | "price";

// failed sends before the founder is asked, a track apart each (an hour)
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

/** How a card names an order: the buyer, what they bought, and where to find it in Stripe. */
const describe = (order: Order): string => {
  const what =
    order.kind === "link"
      ? JSON.stringify(order.name)
      : (store.getListing(order.listingId)?.name ?? order.listingId);
  const who =
    order.kind === "sale" ? `${order.recipient.name}'s ${what} (${order.variant.label})` : what;
  const email = order.email === null ? "" : `, ${order.email}`;
  const payment = order.paymentIntent ?? order.sessionId;
  return `${who}${email}: paid ${formatCents(order.collectedCents)} on ${order.productId}, Stripe payment ${payment}`;
};

const cardTitle = (order: Order, trouble: string): string =>
  `Order ${order.id.slice(0, 8)}: ${trouble}`;

const REFUND = "If it can't ship, refund the buyer in Stripe.";

/**
 * The founder's card for a sale that goes no further on its own, and the sale held until they
 * settle it. Nobody paid a test-mode sale, so nobody is owed a card or a refund: the room hears.
 */
const hold = (sale: Sale, printfulId: number | null, trouble: string, why: string): void => {
  store.updateSale(sale.id, { stage: { kind: "held", printfulId, why } });
  const where = printfulId === null ? "" : ` Printful order ${printfulId}.`;
  if (!sale.livemode) {
    postToRoom({ kind: "office" }, `🧪 Test order ${sale.id.slice(0, 8)} stopped: ${why}${where}`);
    return;
  }
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

/**
 * Keep what Printful says of a sale, and hand the founder a status that went wrong the first
 * time it is read, whichever call read it: a confirmation Printful's billing refuses answers
 * failed or onhold straight away.
 */
const noteStatus = (sale: Sale, printfulId: number, status: string, stage: Sale["stage"]): void => {
  store.updateSale(sale.id, { printfulStatus: status, stage });
  if (sale.livemode && ALARMING.has(status) && status !== sale.printfulStatus) {
    raiseOrderCard(cardTitle(sale, `Printful marked it ${status}`), {
      action: `Check ${describe(sale)}`,
      draft: null,
      instructions: `Printful marked order ${printfulId} ${status}. Printful says why only on its dashboard: check it there, and fix what it asks: after a failed charge, fix your billing, then confirm the order again in Printful's dashboard. ${REFUND}`,
    });
  }
};

/** Take on what Printful already has for a sale: a draft to price, or one already submitted. */
const adopt = (sale: Sale, order: PrintfulOrder): void => {
  noteStatus(
    sale,
    order.id,
    order.status,
    order.status === "draft"
      ? { checks: 0, kind: "pricing", printfulId: order.id }
      : { kind: "confirmed", printfulId: order.id },
  );
};

/**
 * A send that failed for now: tried again on the next track, until the founder is asked. A
 * create that timed out may still have made the draft, so Printful is asked once more first:
 * a draft placed by hand beside it would print and charge twice.
 */
const failedTry = async (
  sale: Sale,
  tries: number,
  reason: string,
  credential: PrintfulCredential,
): Promise<void> => {
  if (tries + 1 < MAX_SEND_TRIES) {
    store.updateSale(sale.id, { stage: { kind: "received", tries: tries + 1 } });
    return;
  }
  const found = await printfulOrders.lookup(sale.id, credential);
  switch (found.kind) {
    case "ok": {
      adopt(sale, found.value);
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
        "IdleBiz could not send it to Printful",
        `IdleBiz tried ${MAX_SEND_TRIES} times to send it to Printful, and Printful has no order for it: ${reason}. Place it by hand in Printful's dashboard.`,
      );
      return;
    }
    case "rejected":
    case "down": {
      hold(
        sale,
        null,
        "IdleBiz could not send it to Printful",
        `IdleBiz tried ${MAX_SEND_TRIES} times to send it to Printful (${reason}), and Printful could not say whether one went through (${found.reason}). Look in Printful's dashboard for an order with external id ${sale.id} before placing it by hand, so it is not placed twice.`,
      );
    }
    // no default
  }
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
  const listing = store.getListing(sale.listingId);
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
    await failedTry(sale, tries, found.reason, credential);
    return;
  }
  const design = await designCheck(listing);
  if (design.kind === "unread") {
    await failedTry(sale, tries, design.reason, credential);
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
    case "missing":
    case "down": {
      await failedTry(sale, tries, made.reason, credential);
    }
    // no default
  }
};

/** What Printful charges for a draft, in cents, once it has priced it in USD. */
const usdCostOf = (costs: PrintfulOrder["costs"]): number | null =>
  costs.kind === "done" && costs.currency === "USD" ? costs.totalCents : null;

/**
 * A test-mode sale, which nobody paid: its draft is deleted, priced or not, so the founder's
 * Printful store holds no order nobody paid for, which confirming by hand would charge them for.
 */
const discard = async (
  sale: Sale,
  printfulId: number,
  costCents: number | null,
  credential: PrintfulCredential,
): Promise<void> => {
  const gone = await printfulOrders.discard(printfulId, credential);
  if (gone.kind !== "ok" && gone.kind !== "missing") {
    report(`test order ${sale.id}`, new Error(`Printful kept test draft ${printfulId}`));
  }
  store.updateSale(sale.id, {
    costCents,
    printfulStatus: gone.kind === "ok" || gone.kind === "missing" ? "deleted" : "draft",
    stage: { kind: "test", printfulId },
  });
};

/** A draft not yet confirmed: read again on the next pulse, until the founder is asked. */
const recheck = async (
  sale: Sale,
  printfulId: number,
  checks: number,
  reason: string,
  credential: PrintfulCredential,
): Promise<void> => {
  if (checks + 1 < MAX_PRICING_CHECKS) {
    store.updateSale(sale.id, { stage: { checks: checks + 1, kind: "pricing", printfulId } });
    return;
  }
  if (!sale.livemode) {
    await discard(sale, printfulId, null, credential);
    postToRoom(
      { kind: "office" },
      `🧪 Test order ${sale.id.slice(0, 8)} was never priced, so its draft is deleted: ${reason}.`,
    );
    return;
  }
  hold(
    sale,
    printfulId,
    "IdleBiz could not confirm it",
    `IdleBiz read Printful's draft ${MAX_PRICING_CHECKS} times without confirming it (last: ${reason}). Check in Printful's dashboard what it costs, and in Stripe that the buyer's payment still stands, then confirm it there if it costs no more than the buyer paid.`,
  );
};

/** Whether the buyer's money is still there, asked right before Printful charges the founder for it. */
const paymentOf = (sale: Sale): Promise<PaymentStanding> => {
  const key = getSecret(STRIPE_SECRET_KEY);
  if (key === null || sale.paymentIntent === null) {
    return Promise.resolve({
      kind: "unread",
      reason:
        key === null ? "IdleBiz has no Stripe key to read the payment" : "Stripe named no payment",
    });
  }
  return readPaymentStanding(key, sale.paymentIntent);
};

/** Why a payment Stripe could read stops Printful's draft of `costCents` being confirmed, or null when nothing does. */
const paymentRefusal = (
  payment: Exclude<PaymentStanding, { kind: "unread" }>,
  costCents: number,
): { trouble: string; why: string } | null => {
  if (payment.kind === "taken") {
    return {
      trouble: "its payment was refunded or disputed",
      why: "Stripe shows the buyer's payment refunded or disputed, so IdleBiz left Printful's draft unconfirmed. Delete the draft in Printful's dashboard, or confirm it there if the buyer is still owed it.",
    };
  }
  // a listing's link takes only cards, but one made before it did can take a method with a dearer fee
  if (payment.method !== "card") {
    const method = payment.method ?? "a method Stripe did not name";
    return {
      trouble: `its buyer paid with ${method}, not a card`,
      why: `The buyer paid with ${method}, whose Stripe fee can be more than the ${STRIPE_FEE_LABEL} of a card that IdleBiz counts on, so IdleBiz left Printful's ${formatCents(costCents)} draft unconfirmed. Check in Stripe's dashboard what the payment netted, then confirm the draft in Printful's dashboard if that covers it, or delete it.`,
    };
  }
  return null;
};

/**
 * Confirm a priced draft, on this read that shows it a draft, only when it costs no more than the
 * buyer paid less Stripe's fee on a card, and the payment was made by card and is neither
 * refunded nor disputed.
 */
const confirm = async (
  sale: Sale,
  order: PrintfulOrder,
  checks: number,
  credential: PrintfulCredential,
): Promise<void> => {
  const { costs } = order;
  if (costs.kind === "calculating") {
    await recheck(sale, order.id, checks, "Printful is still working out its cost", credential);
    return;
  }
  if (!sale.livemode) {
    await discard(sale, order.id, usdCostOf(costs), credential);
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
  const kept = netOfStripeCents(sale.collectedCents);
  if (costCents > kept) {
    hold(
      sale,
      order.id,
      "Printful wants more than the buyer paid",
      `Printful charges ${formatCents(costCents)} to print and ship it, and the buyer paid ${formatCents(sale.collectedCents)}, of which Stripe's fee may leave ${formatCents(kept)}, so IdleBiz left it a draft rather than confirm it at a loss. Confirm it in Printful's dashboard to ship it anyway, or delete the draft.`,
    );
    return;
  }
  const payment = await paymentOf(sale);
  if (payment.kind === "unread") {
    await recheck(
      sale,
      order.id,
      checks,
      `Stripe could not say whether the payment still stands: ${payment.reason}`,
      credential,
    );
    return;
  }
  const refused = paymentRefusal(payment, costCents);
  if (refused !== null) {
    hold(sale, order.id, refused.trouble, refused.why);
    return;
  }
  const confirmed = await printfulOrders.confirm(order.id, credential);
  switch (confirmed.kind) {
    case "ok": {
      noteStatus(sale, order.id, confirmed.value.status, {
        kind: "confirmed",
        printfulId: order.id,
      });
      return;
    }
    case "refused": {
      printfulTokenCard();
      return;
    }
    case "rejected": {
      // the founder may have confirmed it by hand since it was read
      const now = await printfulOrders.read(order.id, credential);
      if (now.kind === "ok" && now.value.status !== "draft") {
        adopt(sale, now.value);
        return;
      }
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
      await recheck(sale, order.id, checks, "its confirmation got no answer", credential);
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
      await recheck(sale, printfulId, checks, read.reason, credential);
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
  // a held draft the founder confirmed by hand is on its way like any other
  const confirmedByHand = sale.stage.kind === "held" && status !== "draft" && status !== "deleted";
  noteStatus(
    sale,
    printfulId,
    status,
    confirmedByHand ? { kind: "confirmed", printfulId } : sale.stage,
  );
};

/** What a sale does next, if anything now: a draft is priced every pulse, the rest waits for a track. */
const stepOf = (
  sale: Sale,
  beat: OrderBeat,
): ((credential: PrintfulCredential) => Promise<void>) | null => {
  const readNow = beat !== "price";
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
 * first, since cards dedupe by title and the kept order is what stops the next read retrying.
 */
const keepUnreadable = (
  session: CheckoutSession,
  productId: string,
  listingId: string,
  why: string,
): void => {
  const order: Order = { ...paidOn(session, productId), kind: "unreadable", listingId, why };
  if (order.livemode) {
    raiseOrderCard(cardTitle(order, "IdleBiz cannot send it"), {
      action: `Settle ${describe(order)}`,
      draft: null,
      instructions: `A buyer paid, but ${why}, so IdleBiz sent nothing to Printful. Place it by hand in Printful's dashboard if you can. ${REFUND}`,
    });
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
    raiseOrderCard(cardTitle(order, "deliver it"), {
      action: `Send ${order.email ?? "the buyer"} what ${JSON.stringify(order.name)} promised`,
      draft: null,
      instructions: `${describe(order)}. The team says to send: ${order.delivery} Press Done once it is sent. If you can't deliver it, refund the buyer in Stripe.`,
    });
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
 * mode never read starts from the floor. Whichever key read last, no key skips what it never read.
 */
const startOf = (cursor: OrdersCursor, reader: string): number => {
  const own = cursor.byKey[reader];
  if (own !== undefined) {
    return own;
  }
  const mode = `${reader.split(":")[0]}:`;
  const sameMode = Object.entries(cursor.byKey)
    .filter(([other]) => other.startsWith(mode))
    .map(([, at]) => at);
  return sameMode.length > 0 ? Math.min(...sameMode) : cursor.floor;
};

/**
 * Keep every paid checkout on the company's links since the key's cursor, and move it up to the
 * oldest that may still be paid: an open one (Stripe expires those within a day), or one whose
 * payment is still on its way.
 */
const takePaidCheckouts = async (now: number): Promise<void> => {
  const key = getSecret(STRIPE_SECRET_KEY);
  if (key === null) {
    return;
  }
  const cursor = store.ordersCursor() ?? {
    byKey: {},
    floor: Math.floor(store.requireCompany().createdAt / 1000) - 1,
  };
  const reader = readerOf(key);
  const from = startOf(cursor, reader);
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
    raiseOrderCard("Paid orders can't be read from Stripe", {
      action: "Let IdleBiz's Stripe key read checkouts",
      draft: null,
      instructions: `Stripe turned IdleBiz's key away when it read checkout sessions (${read.said}), so no paid print reaches Printful and no card tells you what a buyer is owed. In the Budget panel, remove the key and paste one whose restricted permissions include Read on Checkout Sessions, or your secret key. Press Done once it is saved: the waiting orders go out on their own.`,
    });
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
  raiseOrderCard("Paid orders may have been missed", {
    action: "Check Stripe for payments on IdleBiz's payment links",
    draft: null,
    instructions: `More checkouts reached Stripe between two of IdleBiz's reads than one read takes (${CHECKOUT_READ_LIMIT}), which other business on the same account causes, so IdleBiz read only the newest and skipped any made before ${new Date(oldestRead * 1000).toISOString()}. In Stripe's dashboard, look for payments on IdleBiz's payment links before then that no order card or read_orders shows: place a print in Printful by hand, and deliver anything else. ${REFUND}`,
  });
};

/** Carry every order the step its beat allows. One order's fault is its own. */
export const pumpOrders = async (now: number, beat: OrderBeat): Promise<void> => {
  if (store.getCompany() === null) {
    return;
  }
  if (beat === "read") {
    await takePaidCheckouts(now);
  }
  const credential = printfulCredential();
  for (const order of store.listOrders()) {
    if (order.kind !== "sale") {
      continue;
    }
    const step = stepOf(order, beat);
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
