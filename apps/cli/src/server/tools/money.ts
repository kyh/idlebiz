import type { Product } from "@repo/domain/domain";
import { formatCents } from "@repo/domain/format";
import { switchOffRetiredLinks } from "../company-actions";
import { makingPaymentLink } from "../reset-links";
import type { LinkCore, LinkState } from "../link-record";
import type { Order } from "../order";
import { RefusalError } from "../refusal";
import { STRIPE_SECRET_KEY, VERCEL_TOKEN, getSecret } from "../secrets";
import * as store from "../store/store";
import { isTestKey } from "../stripe-api";
import { CHECKOUT_SESSION_PARAM } from "../stripe-links";
import type { StripeAccess } from "../stripe-links";
import { TOOL_SPECS } from "../tool-specs";
import type { ToolName } from "../tool-specs";
import { define, holdFor, needIntegration, productFor, requireSignOff } from "./define";
import type { RunContext, Tool } from "./define";
import { VERCEL_WAITING, domainsLabel, needVercel, productHosts } from "./vercel";

/** Why money on `product` cannot be counted for `bet`, or null when it can. */
export const revenueBetRefusal = (bet: string, product: Product): string | null => {
  const claimed = store.getBet(bet);
  return claimed?.productId === product.id &&
    claimed.claim.metric === "revenue" &&
    (claimed.state.kind === "open" || claimed.state.kind === "measuring")
    ? null
    : `"${bet}" is not a revenue bet on ${product.id} that is open or measuring — read_bets lists every live bet, what it counts and its product.`;
};

export const TEST_MODE =
  " Stripe is in test mode: the link takes no real money, and what it takes counts for nothing unless IdleBiz runs with IDLEBIZ_COUNT_TEST_MONEY=1.";

export const UNRECORDED_LINK =
  "Stripe may have made the payment link: it took the create but answered in a shape IdleBiz does not read, so IdleBiz recorded no link and would never switch one off. Ask the founder to look under Payment Links in their Stripe Dashboard and switch off any it made, rather than sign off again: for a day Stripe answers the same request the same way.";

/** When a task waiting on a Stripe key resumes: main resumes none while `stripeInTestMode`. */
const RESUMES_ON_LIVE_KEY =
  "this task resumes automatically once a live key is saved: a test-mode one counts no money, so it keeps waiting.";

export const NO_STRIPE_KEY = `IdleBiz has no Stripe key to charge with: the founder has a Stripe card waiting that takes them to the Budget panel to add one. Continue with what you can — ${RESUMES_ON_LIVE_KEY}`;

/** Why buyers cannot be sent to `url` once they have paid, or null when they can. */
const afterPaymentRefusal = (url: URL): string | null => {
  if (url.protocol !== "https:") {
    return `${url.href} is not https: buyers who paid are sent only to an https page on the product's own domain.`;
  }
  if (url.username !== "" || url.password !== "") {
    return `${url.href} carries a login: the page buyers land on has to be public, since they arrive with none.`;
  }
  if (url.port !== "") {
    return `${url.href} names port ${url.port}: Vercel serves the product only on https's own port, so name the page without one.`;
  }
  if (url.searchParams.has(CHECKOUT_SESSION_PARAM)) {
    return `${url.href} already has a ${CHECKOUT_SESSION_PARAM}: IdleBiz adds it, filled with each buyer's checkout session, so name the page without it.`;
  }
  return null;
};

/**
 * The page of `product`'s own that buyers land on once they have paid, as the founder signs it;
 * one the product does not serve over https on its production domains ends the call, since that
 * page is where the product checks who paid.
 */
const afterPaymentPage = async (
  ctx: RunContext,
  product: Product,
  page: string,
): Promise<string> => {
  const url = new URL(page);
  const refusal = afterPaymentRefusal(url);
  if (refusal !== null) {
    throw new RefusalError(refusal);
  }
  if (product.vercel === null) {
    throw new RefusalError(
      `${product.name} has no Vercel project yet: deploy the page buyers land on, which makes one, then make the link.`,
    );
  }
  const token =
    getSecret(VERCEL_TOKEN) ??
    needVercel(
      ctx,
      product.id,
      `to check where ${product.name} sends buyers who paid`,
      VERCEL_WAITING,
      "Vercel is not connected.",
    );
  const hosts = await productHosts(ctx, product, product.vercel, token);
  if (!hosts.includes(url.hostname)) {
    throw new RefusalError(
      `${url.href} is not on ${product.name}'s production domains (${domainsLabel(hosts)}): buyers who paid are sent only to a page the product itself serves, where its server checks their checkout.`,
    );
  }
  return url.href;
};

/**
 * What the founder signs for a payment link. The name and delivery are quoted as JSON, so
 * neither can pose as more of the action; the delivery is signed since it is what the founder
 * owes each buyer, and so is the page paying buyers land on, whose href holds no space or quote
 * to pose with.
 */
const chargeAction = (link: {
  name: string;
  price: string;
  product: string;
  bet: string | undefined;
  delivery: string | undefined;
  afterPayment: string | null;
}): string =>
  [
    `payment link ${JSON.stringify(link.name)} at ${link.price} on ${link.product}`,
    link.bet === undefined ? "" : ` for bet ${link.bet}`,
    link.delivery === undefined ? "" : ` delivering ${JSON.stringify(link.delivery)}`,
    link.afterPayment === null ? "" : ` then send buyers to ${link.afterPayment}`,
  ].join("");

/** What a buyer gets once they pay on link `id`, as the agent is told. */
const afterSale = (
  id: string,
  delivery: string | undefined,
  afterPayment: string | null,
): string => {
  const card =
    delivery === undefined
      ? ""
      : " The founder gets a card for each paid checkout, with the buyer's email and your delivery.";
  if (afterPayment === null) {
    return card || " Nothing names a delivery, so a buyer gets only Stripe's receipt.";
  }
  return ` Each buyer who pays lands on ${afterPayment} with a ${CHECKOUT_SESSION_PARAM} naming their checkout session: unlock only what the product's server reads there as paid on this link, ${id}.${card}`;
};

/** What a Stripe key must be granted for a tool, in the words the founder and the agent read. */
export interface StripeGrant {
  can: string;
  why: string;
  permissions: string;
}

const LINK_GRANT: StripeGrant = {
  can: "make payment links",
  permissions: "Write on Payment Links, Prices and Products",
  why: "which charging through one needs",
};

const DELIVERY_GRANT: StripeGrant = {
  can: "read checkouts",
  permissions: "Read on Checkout Sessions",
  why: "which is how each buyer owed a delivery reaches the founder",
};

/** Ask the founder for a Stripe key with `grant` in place of one Stripe turned away, saying `said`, which ends the call. */
export const stripeTurnedAway = (ctx: RunContext, grant: StripeGrant, said: string): never =>
  needIntegration(
    ctx,
    "stripe",
    `Stripe won't let IdleBiz's key ${grant.can}, ${grant.why} (${said}): in the Budget panel, paste over it a key whose restricted permissions include ${grant.permissions}, or your secret key`,
    `Stripe won't let IdleBiz's key ${grant.can}: the founder has a Stripe card waiting to replace the key. Continue with what you can — ${RESUMES_ON_LIVE_KEY}`,
    `Stripe won't let IdleBiz's key ${grant.can}.`,
  );

/** End the call unless Stripe says the founder's key has `grant`. */
export const requireStripeAccess = async (
  ctx: RunContext,
  asked: Promise<StripeAccess>,
  grant: StripeGrant,
): Promise<void> => {
  const access = await asked;
  switch (access.kind) {
    case "granted": {
      return;
    }
    case "refused": {
      return stripeTurnedAway(ctx, grant, access.said);
    }
    case "unreachable": {
      throw new RefusalError(
        `Stripe could not be asked whether IdleBiz's key can ${grant.can} (${access.reason}); try again.`,
      );
    }
    // no default
  }
};

/** How many orders read_orders shows: enough to find the buyer who wrote in, few enough to read. */
const RECENT_ORDERS = 20;

/** Where an order stands, as support should read it. */
const orderStanding = (order: Order): string => {
  if (order.kind === "unreadable") {
    return `not sent to Printful: ${order.why}; the founder handles it`;
  }
  if (order.kind === "link") {
    if (!order.livemode) {
      return "paid in test mode, so nobody paid and nothing is owed";
    }
    return order.delivery === null
      ? "paid through a payment link that names no delivery"
      : `the founder delivers it: ${order.delivery}`;
  }
  const { stage } = order;
  switch (stage.kind) {
    case "received": {
      return "paid, not at Printful yet";
    }
    case "pricing": {
      return `a draft at Printful (order ${stage.printfulId}), being priced`;
    }
    case "confirmed": {
      return `at Printful (order ${stage.printfulId}): ${order.printfulStatus ?? "submitted"}`;
    }
    case "held": {
      return `waiting on the founder: ${stage.why}`;
    }
    case "test": {
      return order.costCents === null
        ? `paid in test mode; Printful never priced draft ${stage.printfulId}, so it was deleted, never sent`
        : `paid in test mode, so only priced as Printful draft ${stage.printfulId}, never sent`;
    }
    // no default
  }
};

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** Whether a payment link still takes money, as a teammate should read it; `retired` is its product's standing. */
const linkStanding = (state: LinkState, retired: boolean): string => {
  switch (state.kind) {
    case "selling": {
      return retired
        ? "not switched off yet: IdleBiz switches it off at Stripe as soon as it can"
        : "selling";
    }
    case "retrying": {
      return `not switched off yet: Stripe did not answer (${state.why}), so IdleBiz asks again each pulse and hands it to the founder if Stripe keeps not answering`;
    }
    case "switched-off": {
      return state.by === "founder"
        ? `switched off by hand in Stripe's dashboard ${dayOf(state.at)}, the founder says, so it takes no new money`
        : `switched off at Stripe ${dayOf(state.at)}, when its product retired, so it takes no new money`;
    }
    case "left-on": {
      return `still on at Stripe, which would not switch it off (${state.why}): the founder switches it off by hand`;
    }
    // no default
  }
};

export const linkEntry = (link: LinkCore): string =>
  `${JSON.stringify(link.name)} ${link.url} is ${linkStanding(link.state, store.isRetiredProduct(link.productId))}`;

/**
 * What became of a link Stripe made while its product retired: switched off at once, as the
 * retirement's own were. Null while the product is live.
 */
export const madeWhileRetiring = async (
  product: Product,
  linkId: string,
): Promise<string | null> => {
  if (!store.isRetiredProduct(product.id)) {
    return null;
  }
  await switchOffRetiredLinks();
  const link = store.paymentLinks().find((l) => l.link.id === linkId)?.link;
  const standing = link === undefined ? "" : ` Its link ${linkEntry(link)}.`;
  return `${product.name} was retired while Stripe made its payment link.${standing} Each order already paid through it still ships.`;
};

/** One order as read_orders lists it: when, what, for how much, where it stands, and who it goes to. */
const orderEntry = (order: Order): string => {
  const listing =
    order.kind === "link"
      ? order.name
      : (store.getListing(order.listingId)?.name ?? order.listingId);
  const day = dayOf(order.createdAt);
  const lines = [`- ${day} · ${listing}`];
  if (order.kind === "sale") {
    const { recipient: to } = order;
    lines[0] += ` (${order.variant.label}) × ${order.quantity}`;
    const address = [
      to.address1,
      to.address2,
      to.city,
      `${to.stateCode} ${to.zip}`,
      to.countryCode,
    ];
    lines.push(
      `  ${[to.name, order.email, to.phone].filter(Boolean).join(", ")}`,
      `  ${address.filter(Boolean).join(", ")}`,
    );
  } else if (order.email !== null) {
    lines.push(`  ${order.email}`);
  }
  lines[0] += ` · paid ${formatCents(order.collectedCents)} · ${orderStanding(order)}`;
  return lines.join("\n");
};

export const MONEY_TOOLS = {
  create_payment_link: define(
    TOOL_SPECS.create_payment_link,
    async (ctx, { afterPaymentUrl, amountUsd, bet, delivery, name, product: named }) => {
      const productId = productFor(ctx, named);
      if (productId === null) {
        throw new RefusalError("There is no product to charge for — create_product first.");
      }
      const product = store.getProduct(productId);
      if (!product) {
        throw new RefusalError(store.noSuchProduct(productId));
      }
      const notTheBet = bet === undefined ? null : revenueBetRefusal(bet, product);
      if (notTheBet !== null) {
        throw new RefusalError(notTheBet);
      }
      const afterPayment =
        afterPaymentUrl === undefined
          ? null
          : await afterPaymentPage(ctx, product, afterPaymentUrl);
      const cents = Math.round(amountUsd * 100);
      const price = formatCents(cents);
      const key = getSecret(STRIPE_SECRET_KEY);
      if (!key) {
        return holdFor(
          ctx,
          {
            integration: "stripe",
            productId: null,
            reason: `to sell ${JSON.stringify(name)} at ${price} through a payment link`,
            type: "integration",
          },
          NO_STRIPE_KEY,
          "IdleBiz has no Stripe key to charge with.",
        );
      }
      await requireStripeAccess(ctx, ctx.linkAccess(key), LINK_GRANT);
      if (delivery !== undefined) {
        await requireStripeAccess(ctx, ctx.checkoutAccess(key), DELIVERY_GRANT);
      }
      requireSignOff(
        ctx,
        chargeAction({ afterPayment, bet, delivery, name, price, product: product.id }),
        "payments",
      );
      const kept = makingPaymentLink();
      try {
        const made = await ctx.createPaymentLink({
          afterPayment,
          bet: bet ?? null,
          cents,
          delivery: delivery ?? null,
          key,
          name,
          product: product.id,
        });
        if (made.kind === "refused") {
          return stripeTurnedAway(ctx, LINK_GRANT, made.said);
        }
        if (made.kind === "failed") {
          throw new RefusalError(`Stripe made no payment link: ${made.error}`);
        }
        if (made.kind === "unrecorded") {
          throw new RefusalError(UNRECORDED_LINK);
        }
        if (store.getChargeLink(made.id) !== null) {
          return `Stripe gave back the payment link it made for this same request within the last day, so no second one was made: ${made.url}`;
        }
        store.recordChargeLink({
          betId: bet ?? null,
          cents,
          createdAt: Date.now(),
          delivery: delivery ?? null,
          id: made.id,
          livemode: !isTestKey(key),
          name,
          productId: product.id,
          state: { kind: "selling" },
          url: made.url,
        });
        const retired = await madeWhileRetiring(product, made.id);
        if (retired !== null) {
          throw new RefusalError(retired);
        }
        const testMode = isTestKey(key) ? TEST_MODE : "";
        return `Created a payment link for "${name}" at ${price} on ${product.name}: ${made.url}${afterSale(made.id, delivery, afterPayment)}${testMode}`;
      } finally {
        kept();
      }
    },
  ),
  read_orders: define(TOOL_SPECS.read_orders, (ctx, { product: named }) => {
    const productId = productFor(ctx, named);
    if (productId === null) {
      throw new RefusalError("There is no product yet — create_product first.");
    }
    const orders = store
      .listOrders()
      .filter((o) => o.productId === productId)
      .toSorted((a, b) => b.createdAt - a.createdAt);
    // a retired product's orders still ship, so its buyers still write in
    const made = orders.length > 0 || store.madeProduct(productId);
    const name = store.getProduct(productId)?.name ?? (made ? productId : null);
    if (name === null) {
      throw new RefusalError(store.noSuchProduct(productId));
    }
    const retired = store.isRetiredProduct(productId);
    const told = store
      .paymentLinks()
      .map(({ link }) => link)
      .filter((l) => l.productId === productId && (retired || l.state.kind !== "selling"));
    const links =
      told.length === 0
        ? ""
        : `\nIts payment links:\n${told.map((l) => `- ${linkEntry(l)}`).join("\n")}`;
    if (orders.length === 0) {
      return `${name} has no paid orders yet.${links}`;
    }
    const shown = orders.slice(0, RECENT_ORDERS);
    return `${name}'s paid orders, newest first (${shown.length} of ${orders.length}):\n${shown.map(orderEntry).join("\n")}${links}`;
  }),
} satisfies Partial<Record<ToolName, Tool>>;
