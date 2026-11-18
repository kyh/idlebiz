import { formatUsd } from "@repo/domain/format";
import type { LinkCore } from "./link-record";
import type { Order } from "./order";
import { RefusalError } from "./refusal";
import { STRIPE_SECRET_KEY } from "./vault/names";
import { getSecret } from "./vault/vault";
import * as store from "./store/store";
import { switchOffPaymentLink } from "./stripe-links";

let resetting = false;
const linksInMaking = new Set<Promise<void>>();

/**
 * Mark a signed payment link in the making, from asking Stripe until it is recorded, and answer
 * the call that ends it. A reset waits for each before it switches off the company's links, and
 * refuses a new one: a link Stripe makes once the save is gone would take money nothing records.
 */
export const makingPaymentLink = () => {
  if (resetting) {
    throw new RefusalError(
      "Nothing was made: the founder is resetting the company, and the save that would record a payment link is being deleted.",
    );
  }

  const made: PromiseWithResolvers<void> = Promise.withResolvers();
  linksInMaking.add(made.promise);

  return (() => {
    linksInMaking.delete(made.promise);
    made.resolve();
  }) satisfies () => void;
};

const switchedOffForReset = async (link: LinkCore, key: string | null) => {
  if (key === null) {
    return "IdleBiz has no Stripe key it can use";
  }

  const done = await switchOffPaymentLink(key, link.id);

  return done.kind === "off" ? null : done.reason;
};

/**
 * Before a reset deletes the save, switch off with the founder's key every live payment link the
 * company still sells through, one at a time as the sweep does: once the save is gone nothing
 * records a link, ships its prints or hands its buyers what they paid for, so it first waits for
 * each link still in the making (`makingPaymentLink`). Answers what the founder must still do by
 * hand (links left on, paid prints Printful never confirmed and the founder has not settled, paid
 * orders whose card is still open), or null when nothing is left.
 */
export const switchOffBeforeReset = async () => {
  resetting = true;
  await Promise.all(linksInMaking);

  if (store.getCompany() === null) {
    return null;
  }

  const key = getSecret(STRIPE_SECRET_KEY);
  const leftOn: string[] = [];

  for (const { link } of store.paymentLinks()) {
    if (!link.livemode || link.state.kind === "switched-off") {
      continue;
    }

    const why = await switchedOffForReset(link, key);

    if (why !== null) {
      leftOn.push(`${JSON.stringify(link.name)} ${link.url} (${link.id}): ${why}`);
    }
  }

  const paid = store.listOrders().filter((o) => o.livemode);

  const openCards = store
    .listOpenTasks()
    .flatMap((t) => (t.origin === "order" && t.state.kind === "blocked" ? [t] : []));

  const cardOf = (o: Order) =>
    openCards.find(({ subject }) => subject.kind === "order" && subject.orderId === o.id)?.title;

  const unsent = paid.flatMap((o) =>
    o.kind === "sale" &&
    o.stage.kind !== "confirmed" &&
    (o.stage.kind !== "held" || cardOf(o) !== undefined)
      ? [
          `${o.recipient.name} (${o.email ?? "no email"}), checkout ${o.sessionId}, paid ${formatUsd(o.collectedCents / 100)}`,
        ]
      : [],
  );

  const waiting = paid.flatMap((o) => {
    const card = cardOf(o);

    if (card === undefined || (o.kind === "sale" && o.stage.kind !== "confirmed")) {
      return [];
    }

    const what = o.kind === "link" ? `${JSON.stringify(o.name)}, ` : "";
    const owed = o.kind === "link" && o.delivery !== null ? `, owed: ${o.delivery}` : "";

    return [
      `${card}: ${what}${o.email ?? "no email"}, checkout ${o.sessionId}, paid ${formatUsd(o.collectedCents / 100)}${owed}`,
    ];
  });

  const left = [
    ...(leftOn.length === 0
      ? []
      : [
          `These payment links still take money: in Stripe's dashboard, open Payment links and deactivate each. ${leftOn.join("; ")}.`,
        ]),
    ...(unsent.length === 0
      ? []
      : [
          `These paid prints were never confirmed at Printful: confirm each one's draft in Printful's dashboard where it has one, place it there by hand where it has none, or refund it in Stripe. ${unsent.join("; ")}.`,
        ]),
    ...(waiting.length === 0
      ? []
      : [
          `These paid orders still wait on you, as their cards said: deliver or settle each one, or refund it in Stripe. ${waiting.join("; ")}.`,
        ]),
  ];

  return left.length === 0 ? null : left.join("\n\n");
};
