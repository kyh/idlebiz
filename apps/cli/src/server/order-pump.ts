import { unreachable } from "@repo/domain/errors";
import * as store from "./store/store";
import { postToRoom, raiseOrderCard } from "./company-actions";
import { report } from "./lib/report";
import { STRIPE_FEE_LABEL, netOfStripeCents, readPrintFile } from "./print-listing";
import { printfulCredential } from "./printful-token";
import type { PrintfulCredential } from "./printful";
import { printfulOrders } from "./printful-orders";
import type { PrintfulOrder } from "./printful-orders";
import { STRIPE_SECRET_KEY } from "./vault/names";
import { getSecret } from "./vault/vault";
import { readPaymentStanding } from "./stripe-checkouts";
import type { PaymentStanding } from "./stripe-checkouts";
import { formatCents } from "@repo/domain/format";
import type { Listing } from "./listing";
import type { Sale } from "./order";
import { REFUND, describe } from "./order-card";
import { takePaidCheckouts } from "./order-intake";

/** How often waiting orders are sent and sent ones' statuses read: Printful takes days to ship. */
export const ORDER_TRACK_MS = 10 * 60_000;

/**
 * What a pulse does for orders: `read` takes new paid checkouts from Stripe, then does what
 * `track` does; `track` sends what waits and reads sent orders' statuses; every beat prices
 * and confirms drafts.
 */
export type OrderBeat = "read" | "track" | "price";

const MAX_SEND_TRIES = 6;
const MAX_PRICING_CHECKS = 20;

const SETTLED = new Set(["fulfilled", "canceled", "deleted"]);
const ALARMING = new Set(["failed", "canceled", "onhold"]);

const hold = (sale: Sale, printfulId: number | null, trouble: string, why: string) => {
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

const printfulTokenCard = () => {
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

const noteStatus = (sale: Sale, printfulId: number, status: string, stage: Sale["stage"]) => {
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

const adopt = (sale: Sale, order: PrintfulOrder) => {
  noteStatus(
    sale,
    order.id,
    order.status,
    order.status === "draft"
      ? { checks: 0, kind: "pricing", printfulId: order.id }
      : { kind: "confirmed", printfulId: order.id },
  );
};

const failedTry = async (
  sale: Sale,
  tries: number,
  reason: string,
  credential: PrintfulCredential,
) => {
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

      return;
    }

    default: {
      return unreachable(found);
    }
  }
};

const designCheck = async (listing: Listing) => {
  for (const { fileUrl, sha256 } of listing.placements) {
    const file = await readPrintFile(fileUrl);

    if (file.kind === "unfit") {
      return { kind: "unread", reason: `${fileUrl} did not load: ${file.reason}` } satisfies
        | { kind: "same" }
        | { kind: "changed"; url: string }
        | { kind: "unread"; reason: string };
    }

    if (file.sha256 !== sha256) {
      return { kind: "changed", url: fileUrl } satisfies
        | { kind: "same" }
        | { kind: "changed"; url: string }
        | { kind: "unread"; reason: string };
    }
  }

  return { kind: "same" } satisfies
    | { kind: "same" }
    | { kind: "changed"; url: string }
    | { kind: "unread"; reason: string };
};

const send = async (sale: Sale, tries: number, credential: PrintfulCredential) => {
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

      return;
    }

    default: {
      return unreachable(made);
    }
  }
};

const usdCostOf = (costs: PrintfulOrder["costs"]) =>
  costs.kind === "done" && costs.currency === "USD" ? costs.totalCents : null;

const discard = async (
  sale: Sale,
  printfulId: number,
  costCents: number | null,
  credential: PrintfulCredential,
) => {
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

const recheck = async (
  sale: Sale,
  printfulId: number,
  checks: number,
  reason: string,
  credential: PrintfulCredential,
) => {
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

const paymentOf = (sale: Sale) => {
  const key = getSecret(STRIPE_SECRET_KEY);

  if (key === null || sale.paymentIntent === null) {
    return Promise.resolve<PaymentStanding>({
      kind: "unread",
      reason:
        key === null ? "IdleBiz has no Stripe key to read the payment" : "Stripe named no payment",
    });
  }

  return readPaymentStanding(key, sale.paymentIntent);
};

const paymentRefusal = (
  payment: Exclude<PaymentStanding, { kind: "unread" }>,
  costCents: number,
) => {
  if (payment.kind === "refused") {
    return {
      trouble: "Stripe won't let IdleBiz read its payment",
      why: `Stripe won't let IdleBiz's key read charges (${payment.reason}), which is how it checks the buyer's payment still stands before Printful charges you, so IdleBiz left Printful's ${formatCents(costCents)} draft unconfirmed. Give the key Read on Charges in Stripe's dashboard, or paste one that has it in the Budget panel, so later orders go out on their own. For this one, check in Stripe that the payment still stands, then confirm the draft in Printful's dashboard, or delete it.`,
    };
  }

  if (payment.kind === "taken") {
    return {
      trouble: "its payment was refunded or disputed",
      why: "Stripe shows the buyer's payment refunded or disputed, so IdleBiz left Printful's draft unconfirmed. Delete the draft in Printful's dashboard, or confirm it there if the buyer is still owed it.",
    };
  }

  if (payment.method !== "card") {
    const method = payment.method ?? "a method Stripe did not name";

    return {
      trouble: `its buyer paid with ${method}, not a card`,
      why: `The buyer paid with ${method}, whose Stripe fee can be more than the ${STRIPE_FEE_LABEL} of a card that IdleBiz counts on, so IdleBiz left Printful's ${formatCents(costCents)} draft unconfirmed. Check in Stripe's dashboard what the payment netted, then confirm the draft in Printful's dashboard if that covers it, or delete it.`,
    };
  }

  return null;
};

const confirm = async (
  sale: Sale,
  order: PrintfulOrder,
  checks: number,
  credential: PrintfulCredential,
) => {
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

    case "missing":
    case "down": {
      await recheck(sale, order.id, checks, "its confirmation got no answer", credential);

      return;
    }

    default: {
      return unreachable(confirmed);
    }
  }
};

const price = async (
  sale: Sale,
  printfulId: number,
  checks: number,
  credential: PrintfulCredential,
) => {
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

      return;
    }

    default: {
      return unreachable(read);
    }
  }
};

const track = async (sale: Sale, printfulId: number, credential: PrintfulCredential) => {
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

  const confirmedByHand = sale.stage.kind === "held" && status !== "draft" && status !== "deleted";
  noteStatus(
    sale,
    printfulId,
    status,
    confirmedByHand ? { kind: "confirmed", printfulId } : sale.stage,
  );
};

const stepOf = (sale: Sale, beat: OrderBeat) => {
  const readNow = beat !== "price";
  const { stage } = sale;

  switch (stage.kind) {
    case "pricing": {
      return ((credential) => price(sale, stage.printfulId, stage.checks, credential)) satisfies
        | ((credential: PrintfulCredential) => Promise<void>)
        | null;
    }

    case "received": {
      return (readNow ? (credential) => send(sale, stage.tries, credential) : null) satisfies
        | ((credential: PrintfulCredential) => Promise<void>)
        | null;
    }

    case "confirmed":
    case "held": {
      const { printfulId } = stage;

      return (
        readNow && printfulId !== null && !SETTLED.has(sale.printfulStatus ?? "")
          ? (credential) => track(sale, printfulId, credential)
          : null
      ) satisfies ((credential: PrintfulCredential) => Promise<void>) | null;
    }

    case "test": {
      return null;
    }

    default: {
      return unreachable(stage);
    }
  }
};

/** Carry every order the step its beat allows. One order's fault is its own. */
export const pumpOrders = async (now: number, beat: OrderBeat) => {
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
