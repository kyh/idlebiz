import * as store from "./store/store";
import { formatCents } from "@repo/domain/format";
import type { Order } from "./order";

/** How a card names an order: the buyer, what they bought, and where to find it in Stripe. */
export const describe = (order: Order): string => {
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

export const REFUND = "If it can't ship, refund the buyer in Stripe.";
