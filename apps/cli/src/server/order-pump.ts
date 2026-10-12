import * as store from "./store/store";
import { postToRoom, raiseOrderCard } from "./company-actions";
import { report } from "./lib/report";
import { STRIPE_FEE_LABEL, netOfStripeCents, readPrintFile } from "./print-listing";
import { printfulCredential } from "./printful-token";
import type { PrintfulCredential } from "./printful";
import { printfulOrders } from "./printful-orders";
import type { PrintfulOrder } from "./printful-orders";
import { STRIPE_SECRET_KEY, getSecret } from "./secrets";
import { readPaymentStanding } from "./stripe-checkouts";
import type { PaymentStanding } from "./stripe-checkouts";
import { formatCents } from "@repo/domain/format";
import type { Listing } from "./listing";
import type { Sale } from "./order";
import { REFUND, describe } from "./order-card";
import { takePaidCheckouts } from "./order-intake";

// Each kept sale becomes one Printful order, placed with the founder's token here in main. Its
// external id is the checkout's hash, so a restart looks it up rather than make it twice. A
// draft charges nothing; it is confirmed only on a read that shows it still a draft, priced at
// no more than the buyer paid less Stripe's fee on a card, with the payment made by card and
// neither refunded nor disputed, so no restart confirms one twice or past that guard.
// Whatever the pump cannot settle goes to the founder as a card: refunds are theirs.

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

/** Printful statuses after which nothing changes. */
const SETTLED = new Set(["fulfilled", "canceled", "deleted"]);
/** Printful statuses the founder has to look at. */
const ALARMING = new Set(["failed", "canceled", "onhold"]);

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
  raiseOrderCard(
    { kind: "order", orderId: sale.id, trouble },
    {
      action: `Settle ${describe(sale)}`,
      draft: null,
      instructions: `${why}${where} ${REFUND}`,
    },
  );
};

const printfulTokenCard = (): void => {
  raiseOrderCard(
    { kind: "pump", reason: "no-printful-token" },
    {
      action: "Paste a new Printful token in the Budget panel",
      draft: null,
      instructions:
        "Printful turned IdleBiz's token away, which happens once one expires, or none is saved, so paid orders cannot reach Printful. Create a private token at developers.printful.com/tokens and paste it in the Budget panel. Press Done once it is saved: the waiting orders go out on their own.",
    },
  );
};

/**
 * Keep what Printful says of a sale, and hand the founder a status that went wrong the first
 * time it is read, whichever call read it: a confirmation Printful's billing refuses answers
 * failed or onhold straight away.
 */
const noteStatus = (sale: Sale, printfulId: number, status: string, stage: Sale["stage"]): void => {
  store.updateSale(sale.id, { printfulStatus: status, stage });
  if (sale.livemode && ALARMING.has(status) && status !== sale.printfulStatus) {
    raiseOrderCard(
      { kind: "order", orderId: sale.id, trouble: `Printful marked it ${status}` },
      {
        action: `Check ${describe(sale)}`,
        draft: null,
        instructions: `Printful marked order ${printfulId} ${status}. Printful says why only on its dashboard: check it there, and fix what it asks: after a failed charge, fix your billing, then confirm the order again in Printful's dashboard. ${REFUND}`,
      },
    );
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
  if (payment.kind === "refused") {
    return {
      trouble: "Stripe won't let IdleBiz read its payment",
      why: `Stripe won't let IdleBiz's key read charges (${payment.said}), which is how it checks the buyer's payment still stands before Printful charges you, so IdleBiz left Printful's ${formatCents(costCents)} draft unconfirmed. Give the key Read on Charges in Stripe's dashboard, or paste one that has it in the Budget panel, so later orders go out on their own. For this one, check in Stripe that the payment still stands, then confirm the draft in Printful's dashboard, or delete it.`,
    };
  }
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
