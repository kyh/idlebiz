import { unreachable } from "@repo/domain/errors";
import * as store from "./store/store";
import { publishActivity } from "./activity";
import { report } from "./lib/report";
import { switchOffPaymentLink } from "./stripe-links";
import { betNews } from "./prompts/briefs";
import { STRIPE_SECRET_KEY } from "./vault/names";
import { getSecret, hasSecret, heldKeyIn } from "./vault/vault";
import { holdsStripeKey, holdsStripeSecretKey } from "./stripe-api";
import { CHAT_EVENT_TEXT } from "@repo/domain/activity";
import type { Bet } from "@repo/domain/bets";
import { isOutOfBudget } from "@repo/domain/domain";
import type {
  ActionAsk,
  ActionReply,
  Company,
  Employee,
  OrderCardSubject,
  ProductDraft,
  Speaker,
  Task,
} from "@repo/domain/domain";
import type { CompanyLink } from "./link-record";
import { RefusalError } from "./refusal";

/**
 * A line in the team room, the only way one is written, so the room agents read
 * and the founder's #team feed hear the same lines. The room keeps it whole, since
 * agents act on it; only the feed's event is capped. `to` names the teammate it is
 * handed to, if any.
 */
export const postToRoom = (from: Speaker, text: string, to: string | null = null) => {
  const { id } = store.postTeamMessage(from, text);
  publishActivity({
    employeeId: from.kind === "employee" ? from.id : null,
    kind: "chat",
    message: text.slice(0, CHAT_EVENT_TEXT),
    payload: { from, line: id, to },
  });
};

export const announceBet = (bet: Bet) => {
  publishActivity({
    kind: "bet.changed",
    message: bet.title,
    payload: { betId: bet.id, state: bet.state },
  });
  postToRoom({ kind: "office" }, betNews(bet));
};

/** Give up on a live bet, from the lead's tool or the founder's panel. */
export const killBet = (betId: string, reason: string) => {
  const killed = store.killBet(betId, reason, Date.now());
  announceBet(killed);

  return killed;
};

/** Start a product, from the lead's tool or the founder's panel. */
export const startProduct = (input: ProductDraft, by: string | null) => {
  const product = store.createProduct(input);
  publishActivity({
    employeeId: by,
    kind: "product.created",
    message: product.name,
    payload: { productId: product.id },
  });
  postToRoom(
    by === null ? { kind: "founder" } : { id: by, kind: "employee" },
    `🆕 New product: ${product.name} — ${product.description}`,
  );

  return product;
};

/** The lead names a product once they know what it is, most often the first one of a company with no pitch. */
export const nameProduct = (productId: string, named: ProductDraft, by: Employee) => {
  const product = store.nameProduct(productId, named);
  publishActivity({
    employeeId: by.id,
    kind: "product.named",
    message: product.name,
    payload: { productId: product.id },
  });
  postToRoom(
    { kind: "office" },
    `🏷 ${by.name} named the product: ${product.name} — ${product.description}`,
  );

  return product;
};

/** Turn autopilot on or off, from the HUD or the tray. */
export const setAutopilot = (on: boolean) => {
  if (on && isOutOfBudget(store.requireCompany())) {
    throw new RefusalError("Out of budget — raise the cap in Budget first.");
  }

  const company = store.setAutopilot(on);
  publishActivity({ kind: "autopilot.changed", payload: { on } });

  return company;
};

export const ship = (
  task: Task,
  at: { runId: string; taskId: string; employeeId: string },
  summary: string,
) => {
  const message = (summary || "shipped work").slice(0, 200);
  store.recordShip(task.productId, message);
  publishActivity({ ...at, kind: "ship", message });
  const ships = store.getCompany()?.ships ?? 0;

  if (ships > 0 && ships % 10 === 0) {
    postToRoom({ kind: "office" }, `🎉 Milestone: ${ships} things shipped — keep going!`);
  }
};

/** Pause autopilot at the cap; running turns finish and report their cost. */
export const haltForBudget = (company: Company) => {
  if (!company.autopilot) {
    return;
  }

  store.setAutopilot(false);
  publishActivity({
    kind: "budget.exhausted",
    payload: { budget: company.budget, spentUsd: company.spentUsd },
  });
};

const PUMP_CARD_TITLES = {
  missed: "Paid orders may have been missed",
  "no-live-key": "Paid orders wait for a live Stripe key",
  "no-printful-token": "Paid orders wait for a Printful token",
  "unreadable-checkouts": "Paid orders can't be read from Stripe",
} satisfies Record<Extract<OrderCardSubject, { kind: "pump" }>["reason"], string>;

const orderCardTitle = (subject: OrderCardSubject) => {
  switch (subject.kind) {
    case "order": {
      return `Order ${subject.orderId.slice(0, 8)}: ${subject.trouble}`;
    }

    case "link-left-on": {
      return `Switch off payment link ${subject.linkId}`;
    }

    case "pump": {
      return PUMP_CARD_TITLES[subject.reason];
    }

    default: {
      return unreachable(subject);
    }
  }
};

/**
 * Hand the founder a card about paid orders: the Inbox shows it beside the team's asks, and
 * the digest counts it. None when one about the same subject still waits.
 */
export const raiseOrderCard = (subject: OrderCardSubject, ask: Omit<ActionAsk, "type">) => {
  const title = orderCardTitle(subject);
  const card = store.raiseOrderCard(subject, title, { ...ask, type: "action" });

  if (card) {
    publishActivity({
      kind: "order.card",
      message: title,
      payload: { open: true, taskId: card.id },
    });
  }

  return card;
};

/**
 * Refuse what the founder typed for the team (the room, an answer, an action's reply) when it
 * holds a key IdleBiz itself uses: every run reads those, and the prompts carry them out.
 */
export const refuseHeldKey = (text: string) => {
  const held = heldKeyIn(text);

  if (held !== null) {
    throw new RefusalError(
      `Nothing was sent: that holds IdleBiz's own ${held}, which never leaves IdleBiz, and your team reads what you send. IdleBiz already uses it for them; a key goes in where IdleBiz asks for it (the Budget panel, a product's Vercel button).`,
    );
  }

  if (holdsStripeSecretKey(text)) {
    throw new RefusalError(
      "Nothing was sent: that holds a Stripe secret key (sk_), which can charge, refund and pay out on your whole account, and your team reads what you send. A Stripe key the team asks for is a restricted one (rk_): Create restricted key in Stripe's dashboard, start from no permissions, and grant only what they named.",
    );
  }
};

const replyText = (reply: ActionReply) => (reply.kind === "cant" ? reply.reason : reply.note);

const switchedOffByHand = (linkId: string) => {
  const held = store.paymentLinks().find((l) => l.link.id === linkId);

  if (held?.link.state.kind === "left-on") {
    store.setLinkState(held, { at: Date.now(), by: "founder", kind: "switched-off" });
  }
};

/**
 * The founder settled an order card. No run carries it on, so what they said goes to the room,
 * where whoever answers the buyer reads it.
 */
export const settleOrderCard = (taskId: string, reply: ActionReply) => {
  const said = replyText(reply);

  if (holdsStripeKey(said)) {
    throw new RefusalError(
      "Nothing was sent: that holds a Stripe key, and what you type here goes to the team room. A key goes in the Budget panel; press Done here with no key once it is saved.",
    );
  }

  refuseHeldKey(said);
  const card = store.closeOrderCard(taskId);

  if (!card) {
    throw new RefusalError("that order card is already settled");
  }

  if (reply.kind === "done" && card.subject.kind === "link-left-on") {
    switchedOffByHand(card.subject.linkId);
  }

  const told =
    reply.kind === "cant" ? `couldn't — ${said}` : `done${said === "" ? "" : ` — ${said}`}`;

  postToRoom({ kind: "founder" }, `📦 ${card.title}: ${told}`);
  publishActivity({
    kind: "order.card",
    message: card.title,
    payload: { open: false, taskId: card.id },
  });

  return card;
};

const office: Speaker = { kind: "office" };

const leaveOn = (held: CompanyLink, why: string) => {
  const { link } = held;
  const named = `${JSON.stringify(link.name)} (${link.url})`;

  if (link.livemode) {
    const sells =
      held.kind === "print"
        ? "it takes money, and each order paid through it still goes to Printful"
        : "it takes money";

    raiseOrderCard(
      { kind: "link-left-on", linkId: link.id },
      {
        action: `Switch off ${named}, a payment link of retired ${link.productId}, in Stripe's dashboard`,
        draft: null,
        instructions: `${link.productId} is retired, but Stripe would not switch off its payment link ${link.id} for IdleBiz: ${why}. Until it is off, ${sells}. In Stripe's dashboard, open Payment links, find ${link.id} and deactivate it. Press Done once it is off.`,
      },
    );
  } else {
    postToRoom(
      office,
      `🧪 Test payment link ${named} of retired ${link.productId} stays on: ${why}.`,
    );
  }

  store.setLinkState(held, { kind: "left-on", why });
};

const MAX_SWITCH_OFF_TRIES = 10;

const switchOff = async (held: CompanyLink, key: string | null) => {
  const { link } = held;

  try {
    if (key === null) {
      leaveOn(held, "IdleBiz has no Stripe key");

      return;
    }

    const done = await switchOffPaymentLink(key, link.id);

    switch (done.kind) {
      case "off": {
        store.setLinkState(held, { at: Date.now(), by: "idlebiz", kind: "switched-off" });
        postToRoom(
          office,
          `🔌 Switched off ${JSON.stringify(link.name)}, a payment link of retired ${link.productId}: it takes no new money.`,
        );
        break;
      }

      case "refused": {
        leaveOn(held, done.reason);
        break;
      }

      case "unanswered": {
        const tries = (link.state.kind === "retrying" ? link.state.tries : 0) + 1;

        if (tries >= MAX_SWITCH_OFF_TRIES) {
          leaveOn(held, `Stripe did not answer ${tries} times (${done.reason})`);
        } else {
          store.setLinkState(held, { kind: "retrying", tries, why: done.reason });
        }

        break;
      }

      default: {
        return unreachable(done);
      }
    }
  } catch (error) {
    report(`payment link ${link.id}`, error);
  }
};

const sweepRetiredLinks = async () => {
  if (store.getCompany() === null) {
    return;
  }

  const key = getSecret(STRIPE_SECRET_KEY);

  if (key === null && hasSecret(STRIPE_SECRET_KEY)) {
    return;
  }

  const due = store
    .paymentLinks()
    .filter(
      ({ link }) =>
        (link.state.kind === "selling" || link.state.kind === "retrying") &&
        store.isRetiredProduct(link.productId),
    );

  for (const held of due) {
    await switchOff(held, key);
  }
};

const sweepReported = async (after: Promise<void>) => {
  await after;

  try {
    await sweepRetiredLinks();
  } catch (error) {
    report("retired links", error);
  }
};

let lastSweep: Promise<void> = Promise.resolve();

/**
 * Switch off, with the founder's key here in main, every payment link a retired product still
 * sells through, so it takes no new money; what it already took still counts and still ships.
 * Retirement asks, and so does every pulse, which finishes what a quit cut short. Each sweep
 * waits for the last, so two never ask Stripe about one link at once. Never rejects.
 */
export const switchOffRetiredLinks = () => {
  lastSweep = sweepReported(lastSweep);

  return lastSweep;
};

/**
 * Retire a product and everything riding on it, then switch off its payment links. The
 * retirement never waits on Stripe, only the answer does. `by` is the lead who called it; null
 * is the founder.
 */
export const retireProduct = async (productId: string, reason: string, by: string | null) => {
  const product = store.requireProduct(productId);

  for (const bet of store.killProduct(productId, reason, by)) {
    announceBet(bet);
  }

  postToRoom(
    by === null ? { kind: "founder" } : { id: by, kind: "employee" },
    `🪦 Retired ${product.name} — ${reason}`,
  );
  publishActivity({
    employeeId: by,
    kind: "product.killed",
    message: product.name,
    payload: { productId, reason },
  });
  await switchOffRetiredLinks();

  return product;
};
