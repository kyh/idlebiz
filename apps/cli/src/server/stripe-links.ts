import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError, getJson, postForm, postFormAnswer } from "./lib/http";
import type { VendorAnswer } from "./lib/vendor-call";
import { STRIPE_API, answeringStripe, stripeHeaders } from "./stripe-api";
import type { JsonValue } from "@repo/domain/json";
import type { ListingVariant } from "./listing";
import { StripeLinkIdSchema } from "./link-record";

/** One price in USD, sold once through a link whose every payment carries the product's tag and, when named, the bet's. */
interface PaymentLinkRequest {
  key: string;
  name: string;
  cents: number;
  product: string;
  bet: string | null;
  /** What the founder hands each buyer, which the order card for each paid checkout quotes. */
  delivery: string | null;
  /** The product's own page a buyer lands on once they have paid, in place of Stripe's receipt. */
  afterPayment: string | null;
}

/**
 * The link Stripe made, or why none is known: `refused` is the key turned away (401/403), which
 * only another key gets past; `failed` is anything else, either reason in Stripe's words when it
 * gave any; `unrecorded` is a create Stripe took but answered in a shape IdleBiz does not read,
 * so a live link may stand on Stripe that nothing records.
 */
type LinkResult =
  | { kind: "made"; id: string; url: string }
  | { kind: "refused"; said: string }
  | { kind: "failed"; error: string }
  | { kind: "unrecorded" };

export type PaymentLinker = (req: PaymentLinkRequest) => Promise<LinkResult>;

const Created = z.object({ id: z.string() });
const LinkWithId = z.object({ id: StripeLinkIdSchema, url: z.url() });

/**
 * The link a create answered with. Its answer is read apart from the create, since one IdleBiz
 * cannot read comes after Stripe made the link, which then stands live with nothing recording it.
 */
const linkOf = async (created: VendorAnswer<JsonValue>, what: string): Promise<LinkResult> => {
  if (created.kind !== "ok") {
    return created.kind === "refused"
      ? { kind: "refused", said: created.reason }
      : { error: created.reason, kind: "failed" };
  }
  const link = await answeringStripe(what, () => LinkWithId.parse(created.value));
  return link.kind === "ok"
    ? { id: link.value.id, kind: "made", url: link.value.url }
    : { kind: "unrecorded" };
};

/** The query parameter a buyer lands back on the product with, naming their checkout session. */
export const CHECKOUT_SESSION_PARAM = "session_id";

/**
 * `page` with the parameter Stripe fills with the paid checkout session's id, which the product's
 * server reads the session by. The placeholder has to reach Stripe as written, so it is added to
 * the text rather than through `searchParams`, which would escape its braces.
 */
const withCheckoutSession = (page: string): string => {
  const url = new URL(page);
  const query = url.search === "" ? "?" : `${url.search}&`;
  return `${url.origin}${url.pathname}${query}${CHECKOUT_SESSION_PARAM}={CHECKOUT_SESSION_ID}${url.hash}`;
};

/** Where Stripe sends a buyer once they have paid: the product's page, or its own receipt. */
const afterCompletion = (page: string | null): Record<string, string> =>
  page === null
    ? {}
    : {
        "after_completion[redirect][url]": withCheckoutSession(page),
        "after_completion[type]": "redirect",
      };

/** Each tag as a form field under `prefix`, the way Stripe reads a map. */
const underKey = (prefix: string, tags: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(tags).map(([key, value]) => [`${prefix}[${key}]`, value]));

// each key passed over took a sign-off of its own; this only stops a replay loop Stripe never sends
const MAX_KEYS_PASSED = 20;

const replayedIn = (headers: Headers): boolean => headers.get("Idempotent-Replayed") === "true";

const Switched = z.object({ active: z.boolean() });

/**
 * Whether the link a replayed create answers with is switched off by now: Stripe replays the
 * link as it was made, and a reset, a retirement or the founder may have switched it off since.
 *
 * A replay naming no link, or one Stripe would not look up, counts as still on: either way Stripe
 * made a link for this request, so it is read like any create's answer and recorded where it can
 * be, where retiring its product switches it off. Called a failed create instead, it would tell the
 * agent Stripe made none, and every sign-off for a day would get the same replay.
 */
const switchedOffSince =
  (key: string) =>
  async (replayed: JsonValue): Promise<boolean> => {
    const made = Created.safeParse(replayed);
    if (!made.success) {
      return false;
    }
    const link = await answeringStripe("payment link lookup", async () =>
      Switched.parse(
        await getJson(
          `${STRIPE_API}/v1/payment_links/${encodeURIComponent(made.data.id)}`,
          stripeHeaders(key),
        ),
      ),
    );
    return link.kind === "ok" && !link.value.active;
  };

/**
 * Stripe replays the first answer to a key for 24 hours, so a link tried again after a timeout
 * gets back the price, rate and link Stripe already made, rather than a second live link tagged
 * for it that nothing saved knows, which retiring its product would never switch off. The key
 * covers every field sent, since Stripe refuses a key sent again with other fields; `owner` is
 * the product, and the listing for a print.
 *
 * Stripe replays a failure too, a 500 included, so a key it answered with one would fail every
 * sign-off for a day, and so does a replayed answer `dead` finds no longer any use, such as a
 * link switched off since. Either moves on to the next key in the sequence; a key whose request
 * got no answer is never passed, so a retry after a timeout still finds what Stripe made.
 * Stripe calls a 500's outcome indeterminate, so passing one can leave a second link, which a
 * founder signing again for the same link accepts over a day with none.
 */
const idempotentPost =
  (key: string, owner: readonly string[]) =>
  (
    path: string,
    form: Readonly<Record<string, string>>,
    dead: (replayed: JsonValue) => Promise<boolean> = () => Promise.resolve(false),
  ): Promise<JsonValue> => {
    const digest = createHash("sha256")
      .update(JSON.stringify([...owner, path, form]))
      .digest("hex");
    const send = async (attempt: number): Promise<JsonValue> => {
      const more = attempt + 1 < MAX_KEYS_PASSED;
      try {
        const { body, headers } = await postFormAnswer(
          `${STRIPE_API}${path}`,
          {
            ...stripeHeaders(key),
            "Idempotency-Key": `idlebiz-${digest}${attempt === 0 ? "" : `-${attempt}`}`,
          },
          form,
        );
        if (!(more && replayedIn(headers) && (await dead(body)))) {
          return body;
        }
      } catch (error) {
        if (!(more && error instanceof HttpError && replayedIn(error.headers))) {
          throw error;
        }
      }
      return await send(attempt + 1);
    };
    return send(0);
  };

/** A payment link made on Stripe here in main, so an employee's process never holds the key. */
export const stripePaymentLink: PaymentLinker = async ({
  afterPayment,
  key,
  name,
  cents,
  product,
  bet,
  delivery,
}) => {
  const post = idempotentPost(key, [product]);
  const tags: Record<string, string> = bet === null ? { product } : { bet, product };
  // the link's metadata alone reaches its checkout sessions, where the order pump reads it
  const onSessions = delivery === null ? tags : { ...tags, delivery };
  const created = await answeringStripe("payment link", async () => {
    const price = Created.parse(
      await post("/v1/prices", {
        currency: "usd",
        "product_data[name]": name,
        unit_amount: String(cents),
      }),
    );
    return await post(
      "/v1/payment_links",
      {
        "line_items[0][price]": price.id,
        "line_items[0][quantity]": "1",
        ...afterCompletion(afterPayment),
        // the charge the app counts copies its payment's metadata, never the link's;
        // the link's own tags are how the founder finds it in Stripe
        ...underKey("metadata", onSessions),
        ...underKey("payment_intent_data[metadata]", tags),
      },
      switchedOffSince(key),
    );
  });
  return await linkOf(created, "payment link");
};

/** A physical item sold once per payment, shipped at a fixed rate to a US address the link collects. */
interface ShippedLinkRequest {
  key: string;
  name: string;
  priceCents: number;
  shippingCents: number;
  /** More than one is a required choice on the payment page, its value the Printful variant id. */
  variants: readonly ListingVariant[];
  product: string;
  bet: string | null;
  listing: string;
}

export type ShippedLinker = (req: ShippedLinkRequest) => Promise<LinkResult>;

/** The custom field a buyer picks the variant in; fulfilment reads the choice back by it. */
export const VARIANT_FIELD = "variant";

const variantChoice = (variants: readonly ListingVariant[]): Record<string, string> =>
  variants.length < 2
    ? {}
    : {
        "custom_fields[0][key]": VARIANT_FIELD,
        "custom_fields[0][label][custom]": "Option",
        "custom_fields[0][label][type]": "custom",
        "custom_fields[0][type]": "dropdown",
        ...Object.fromEntries(
          variants.flatMap(({ id, label }, i) => [
            [`custom_fields[0][dropdown][options][${i}][label]`, label],
            [`custom_fields[0][dropdown][options][${i}][value]`, String(id)],
          ]),
        ),
      };

/** Whether a key may make shipping rates and read checkouts and charges, which a restricted key needs granted on their own. */
export type StripeAccess =
  | { kind: "granted" }
  | { kind: "refused"; said: string }
  | { kind: "unreachable"; reason: string };

/** Whether `key` may make each read, as the founder is told to fix it. */
const accessTo = async (key: string, reads: readonly string[]): Promise<StripeAccess> => {
  const asked = await answeringStripe("access", async () => {
    for (const read of reads) {
      await getJson(`${STRIPE_API}${read}`, stripeHeaders(key));
    }
  });
  if (asked.kind === "ok") {
    return { kind: "granted" };
  }
  return asked.kind === "refused"
    ? { kind: "refused", said: asked.reason }
    : { kind: "unreachable", reason: asked.reason };
};

const CHECKOUTS = "/v1/checkout/sessions?limit=1";

/**
 * Ask Stripe whether `key` reaches shipping rates, which a listing makes, checkout sessions,
 * which is how each paid order is found, and charges, which show its payment still stands before
 * Printful is paid for it, before the founder signs off on a listing: a restricted key made before
 * prints were sold is fixed first, rather than fail after the sign-off or leave paid orders
 * unsent. Only a read can be asked without making anything: write implies read, so this catches a
 * key with no grant on shipping rates, not one granted Read alone.
 */
export const stripeListingAccess = (key: string): Promise<StripeAccess> =>
  accessTo(key, ["/v1/shipping_rates?limit=1", CHECKOUTS, "/v1/charges?limit=1"]);

/**
 * Whether `key` reaches payment links, asked before the founder signs off on one, so a key rolled,
 * revoked or expired since it was saved is replaced first rather than spend the sign-off. Write
 * implies read, so this is the read every key that can make a link has.
 */
export const stripeLinkAccess = (key: string): Promise<StripeAccess> =>
  accessTo(key, ["/v1/payment_links?limit=1"]);

/** Whether `key` reads checkout sessions, which is how each buyer a link owes a delivery is found. */
export const stripeCheckoutAccess = (key: string): Promise<StripeAccess> =>
  accessTo(key, [CHECKOUTS]);

/**
 * A print-on-demand item's payment link, tagged like any other so its money counts for the
 * product and the bet, and for the listing, so each paid order can be sent to Printful.
 */
export const stripeShippedLink: ShippedLinker = async (req) => {
  const { bet, key, listing, name, priceCents, product, shippingCents, variants } = req;
  const tags: Record<string, string> =
    bet === null ? { listing, product } : { bet, listing, product };
  const post = idempotentPost(key, [product, listing]);
  const created = await answeringStripe("print payment link", async () => {
    const price = Created.parse(
      await post("/v1/prices", {
        currency: "usd",
        "product_data[name]": name,
        unit_amount: String(priceCents),
      }),
    );
    const rate = Created.parse(
      await post("/v1/shipping_rates", {
        display_name: "Standard shipping",
        "fixed_amount[amount]": String(shippingCents),
        "fixed_amount[currency]": "usd",
        type: "fixed_amount",
      }),
    );
    return await post(
      "/v1/payment_links",
      {
        "line_items[0][price]": price.id,
        "line_items[0][quantity]": "1",
        // the price floor counts on a card's fee; Klarna's or Affirm's is dearer, and Stripe
        // offers any method the account has on unless the link names its own
        "payment_method_types[0]": "card",
        "shipping_address_collection[allowed_countries][0]": "US",
        "shipping_options[0][shipping_rate]": rate.id,
        ...variantChoice(variants),
        ...underKey("metadata", tags),
        ...underKey("payment_intent_data[metadata]", tags),
      },
      switchedOffSince(key),
    );
  });
  return await linkOf(created, "print payment link");
};

/**
 * `refused` when Stripe answered no, which asking again would answer the same; `unanswered` when
 * it was busy (429), failing (5xx), out of reach or answered in a shape IdleBiz does not read,
 * which the next ask may get past. `error` is why, in Stripe's words when it gave any.
 */
export type SwitchOffResult =
  | { kind: "off" }
  | { kind: "refused"; error: string }
  | { kind: "unanswered"; error: string };

/**
 * Switch a payment link off with the founder's key, here in main: its URL then shows the buyer
 * that it is deactivated. Asking again of a link already off answers the same.
 */
export const switchOffPaymentLink = async (key: string, id: string): Promise<SwitchOffResult> => {
  const answer = await answeringStripe("payment link switch-off", async () =>
    Switched.parse(
      await postForm(
        `${STRIPE_API}/v1/payment_links/${encodeURIComponent(id)}`,
        stripeHeaders(key),
        { active: "false" },
      ),
    ),
  );
  switch (answer.kind) {
    case "ok": {
      return answer.value.active
        ? { error: "Stripe still lists it as active", kind: "refused" }
        : { kind: "off" };
    }
    case "down": {
      return { error: answer.reason, kind: "unanswered" };
    }
    case "refused":
    case "missing":
    case "rejected": {
      return { error: answer.reason, kind: "refused" };
    }
    // no default
  }
};
