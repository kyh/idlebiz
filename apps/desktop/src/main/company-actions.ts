import * as store from "@/main/store/store";
import { publishActivity } from "@/main/activity";
import { report } from "@/main/lib/report";
import { readActiveLinks, switchOffPaymentLink } from "@/main/payment-links";
import type { ActiveLinksRead } from "@/main/payment-links";
import { betNews } from "@/main/prompts/briefs";
import { STRIPE_SECRET_KEY, getSecret, hasSecret, heldKeyIn } from "@/main/secrets";
import { isTestKey } from "@/main/stripe-api";
import type { Bet } from "@/shared/bets";
import type {
  ActionAsk,
  ActionReply,
  Company,
  Product,
  ProductDraft,
  Speaker,
  Task,
} from "@/shared/domain";
import type { CompanyLink } from "@/shared/payment-link";
import { RefusalError } from "@/shared/refusal";

// A change to the company that everyone should hear about: the store mutation,
// the activity event and the team-room line, together. The scheduler, the
// agents' tools and the founder's IPC all come through here, so a change reads
// the same whoever made it.

/**
 * A line in the team room, the only way one is written, so the room agents read
 * and the founder's #team feed hear the same lines. The room keeps it whole, since
 * agents act on it; only the feed's event is capped. `to` names the teammate it is
 * handed to, if any.
 */
export const postToRoom = (from: Speaker, text: string, to: string | null = null): void => {
  store.postTeamMessage(from, text);
  publishActivity({
    employeeId: from.kind === "employee" ? from.id : null,
    kind: "chat",
    message: text.slice(0, 400),
    payload: { from, to },
  });
};

export const announceBet = (bet: Bet): void => {
  publishActivity({
    kind: "bet.changed",
    message: bet.title,
    payload: { betId: bet.id, state: bet.state },
  });
  postToRoom({ kind: "office" }, betNews(bet));
};

/** Give up on a live bet, from the lead's tool or the founder's panel. */
export const killBet = (betId: string, reason: string): Bet => {
  const killed = store.killBet(betId, reason, Date.now());
  announceBet(killed);
  return killed;
};

/** Start a product, from the lead's tool or the founder's panel. */
export const startProduct = (input: ProductDraft, by: string | null): Product => {
  const product = store.createProduct(input);
  publishActivity({
    employeeId: by,
    kind: "product.created",
    message: product.name,
    payload: { productId: product.id },
  });
  return product;
};

/** Turn autopilot on or off, from the HUD or the tray. */
export const setAutopilot = (on: boolean): Company => {
  const company = store.setAutopilot(on);
  publishActivity({ kind: "autopilot.changed", payload: { on } });
  return company;
};

export const ship = (
  task: Task,
  at: { runId: string; taskId: string; employeeId: string },
  summary: string,
): void => {
  const message = (summary || "shipped work").slice(0, 200);
  store.recordShip(task.productId, message);
  publishActivity({ ...at, kind: "ship", message });
  const ships = store.getCompany()?.ships ?? 0;
  if (ships > 0 && ships % 10 === 0) {
    postToRoom({ kind: "office" }, `🎉 Milestone: ${ships} things shipped — keep going!`);
  }
};

/** Pause autopilot at the cap; running turns finish and report their cost. */
export const haltForBudget = (company: Company, spentUsd = company.spentUsd): void => {
  if (!company.autopilot) {
    return;
  }
  store.setAutopilot(false);
  publishActivity({
    kind: "budget.exhausted",
    payload: { budget: company.budget, spentUsd },
  });
};

/**
 * Hand the founder a card about a paid order: the Inbox shows it beside the team's asks, and
 * the digest counts it. None when one with this title still waits.
 */
export const raiseOrderCard = (title: string, ask: Omit<ActionAsk, "type">): Task | null => {
  const card = store.raiseOrderCard(title, { ...ask, type: "action" });
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
export const refuseHeldKey = (text: string): void => {
  const held = heldKeyIn(text);
  if (held !== null) {
    throw new RefusalError(
      `Nothing was sent: that holds IdleBiz's own ${held}, which never leaves IdleBiz, and your team reads what you send. IdleBiz already uses it for them; a key goes in where IdleBiz asks for it (the Budget panel, a product's Vercel button).`,
    );
  }
};

// a Stripe secret or restricted key, which no order card asks for
const STRIPE_KEY_IN_TEXT = /\b[rs]k_(?:live|test)_[0-9A-Za-z]{8,}/u;

const replyText = (reply: ActionReply): string =>
  reply.kind === "cant" ? reply.reason : reply.note;

const SWITCH_OFF_CARD = "Switch off payment link ";

const switchOffCard = (linkId: string): string => `${SWITCH_OFF_CARD}${linkId}`;

/** The founder's Done on a link's switch-off card says they switched it off in Stripe's dashboard. */
const switchedOffByHand = (title: string): void => {
  const linkId = title.startsWith(SWITCH_OFF_CARD) ? title.slice(SWITCH_OFF_CARD.length) : null;
  const link = store.paymentLinks().find((l) => l.id === linkId);
  if (link?.state.kind === "left-on") {
    store.setLinkState(link.id, { at: Date.now(), by: "founder", kind: "switched-off" });
  }
};

/**
 * The founder settled an order card. No run carries it on, so what they said goes to the room,
 * where whoever answers the buyer reads it.
 */
export const settleOrderCard = (taskId: string, reply: ActionReply): Task => {
  const said = replyText(reply);
  refuseHeldKey(said);
  if (STRIPE_KEY_IN_TEXT.test(said)) {
    throw new RefusalError(
      "Nothing was sent: that holds a Stripe key, and what you type here goes to the team room. A key goes in the Budget panel; press Done here with no key once it is saved.",
    );
  }
  const card = store.closeOrderCard(taskId);
  if (!card) {
    throw new RefusalError("that order card is already settled");
  }
  if (reply.kind === "done") {
    switchedOffByHand(card.title);
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

/**
 * Hand the founder a link Stripe would not switch off, to switch off by hand; a test-mode link
 * takes no real money, so the room hears instead. The card is raised before the link is marked,
 * since cards dedupe by title and the mark is what stops the next sweep asking Stripe again.
 */
const leaveOn = (link: CompanyLink, why: string): void => {
  const named = `${JSON.stringify(link.name)} (${link.url})`;
  if (link.livemode) {
    const sells = link.print
      ? "it takes money, and each order paid through it still goes to Printful"
      : "it takes money";
    raiseOrderCard(switchOffCard(link.id), {
      action: `Switch off ${named}, a payment link of retired ${link.productId}, in Stripe's dashboard`,
      draft: null,
      instructions: `${link.productId} is retired, but Stripe would not switch off its payment link ${link.id} for IdleBiz: ${why}. Until it is off, ${sells}. In Stripe's dashboard, open Payment links, find ${link.id} and deactivate it. Press Done once it is off.`,
    });
  } else {
    postToRoom(
      office,
      `🧪 Test payment link ${named} of retired ${link.productId} stays on: ${why}.`,
    );
  }
  store.setLinkState(link.id, { kind: "left-on", why });
};

// ten sweeps is about five minutes of pulses: long enough to ride out a burst of 429s or a blip,
// short enough that the founder hears of a link still taking money while it matters
const MAX_SWITCH_OFF_TRIES = 10;

const switchOff = async (link: CompanyLink, key: string | null): Promise<void> => {
  try {
    if (key === null) {
      leaveOn(link, "IdleBiz has no Stripe key");
      return;
    }
    const done = await switchOffPaymentLink(key, link.id);
    switch (done.kind) {
      case "off": {
        store.setLinkState(link.id, { at: Date.now(), by: "idlebiz", kind: "switched-off" });
        postToRoom(
          office,
          `🔌 Switched off ${JSON.stringify(link.name)}, a payment link of retired ${link.productId}: it takes no new money.`,
        );
        break;
      }
      case "refused": {
        leaveOn(link, done.error);
        break;
      }
      case "unanswered": {
        const tries = (link.state.kind === "retrying" ? link.state.tries : 0) + 1;
        if (tries >= MAX_SWITCH_OFF_TRIES) {
          leaveOn(link, `Stripe did not answer ${tries} times (${done.error})`);
        } else {
          store.setLinkState(link.id, { kind: "retrying", tries, why: done.error });
        }
        break;
      }
      // no default
    }
  } catch (error) {
    report(`payment link ${link.id}`, error);
  }
};

/** Stripe's active links, read only with a live key: a test-mode key lists none of the live ones. */
const activeLinks = (key: string | null): Promise<ActiveLinksRead> | null =>
  key === null || isTestKey(key) ? null : readActiveLinks(key);

/** What Stripe showed of a retired product's unrecorded links, as its card says it; null when it has none. */
const unrecordedSeen = (
  read: Exclude<ActiveLinksRead, { kind: "failed" }>,
  productId: string,
  known: ReadonlySet<string>,
): string | null => {
  if (read.kind === "refused") {
    return `Stripe turned IdleBiz's key away when it looked for them (${read.said}).`;
  }
  const found = read.links.filter((l) => l.tags.product === productId && !known.has(l.id));
  if (read.whole && found.length === 0) {
    return null;
  }
  const listed =
    found.length === 0
      ? []
      : [
          `Stripe lists these active ones tagged for it: ${found.map((l) => `${l.url} (${l.id})`).join(", ")}.`,
        ];
  const partial = read.whole
    ? []
    : ["IdleBiz read only part of the account's links, so there may be more."];
  return [...listed, ...partial].join(" ");
};

/**
 * Hand the founder the links older builds made for a retired product and never recorded. Stripe's
 * links carry no date and older builds tagged them by product alone, so another company's tagged
 * the same would read as this one's: the founder switches them off, never IdleBiz. Each product is
 * looked for once, on a live key; a read that failed is tried again on the next sweep.
 */
const handOverUnrecordedLinks = async (key: string | null): Promise<void> => {
  const pending = store.unrecordedLinkProducts();
  const retired = pending.filter((id) => store.isRetiredProduct(id));
  const reading = retired.length === 0 ? null : activeLinks(key);
  if (reading === null) {
    return;
  }
  const read = await reading;
  if (read.kind === "failed") {
    report("retired links", new Error(`Stripe's payment links could not be read: ${read.reason}`));
    return;
  }
  const known = new Set(store.paymentLinks().map((l) => l.id));
  for (const productId of retired) {
    const seen = unrecordedSeen(read, productId, known);
    if (seen === null) {
      continue;
    }
    raiseOrderCard(`Switch off ${productId}'s older payment links`, {
      action: `Switch off the payment links older IdleBiz made for retired ${productId}, in Stripe's dashboard`,
      draft: null,
      instructions: `${productId} is retired. Older versions of IdleBiz kept no record of the payment links they made, and Stripe's links carry no date, so IdleBiz cannot tell its own from another company's with the same tag, and left them on. ${seen} In Stripe's dashboard, open Payment links and deactivate each whose metadata names product ${productId} and is this company's. Press Done once they are off.`,
    });
  }
  store.setUnrecordedLinkProducts(pending.filter((id) => !retired.includes(id)));
};

const sweepRetiredLinks = async (): Promise<void> => {
  if (store.getCompany() === null) {
    return;
  }
  const key = getSecret(STRIPE_SECRET_KEY);
  if (key === null && hasSecret(STRIPE_SECRET_KEY)) {
    // a key this launch cannot open (no Keychain, or it refused) is still the founder's: its
    // links wait for it rather than be handed over as keyless, and boot's report says why
    return;
  }
  const due = store
    .paymentLinks()
    .filter(
      (l) =>
        (l.state.kind === "selling" || l.state.kind === "retrying") &&
        store.isRetiredProduct(l.productId),
    );
  // one at a time: a burst of switch-offs is what Stripe's rate limit turns away
  for (const link of due) {
    await switchOff(link, key);
  }
  await handOverUnrecordedLinks(key);
};

const sweepReported = async (after: Promise<void>): Promise<void> => {
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
export const switchOffRetiredLinks = (): Promise<void> => {
  lastSweep = sweepReported(lastSweep);
  return lastSweep;
};

/**
 * Retire a product and everything riding on it, then switch off its payment links. The
 * retirement never waits on Stripe, only the answer does. `by` is the lead who called it; null
 * is the founder.
 */
export const retireProduct = async (
  productId: string,
  reason: string,
  by: string | null,
): Promise<Product> => {
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
