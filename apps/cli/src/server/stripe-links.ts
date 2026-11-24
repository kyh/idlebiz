import { unreachable } from "@repo/domain/errors";
import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError, getJson, postForm, postFormAnswer } from "./lib/http";
import type { VendorAnswer } from "./lib/vendor-call";
import { STRIPE_API, answeringStripe, stripeHeaders } from "./stripe-api";
import type { JsonValue } from "@repo/domain/json";
import type { ListingVariant } from "./link-record";
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
 * `unrecorded` is a create Stripe took but answered in a shape IdleBiz does not read, so a live
 * link may stand on Stripe that nothing records.
 */
type LinkResult =
  | { kind: "made"; id: string; url: string }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "unrecorded" };

export type PaymentLinker = (req: PaymentLinkRequest) => Promise<LinkResult>;

const Created = z.object({ id: z.string() });
const LinkWithId = z.object({ id: StripeLinkIdSchema, url: z.url() });

const linkOf = async (created: VendorAnswer<JsonValue>, what: string) => {
  if (created.kind !== "ok") {
    return (
      created.kind === "refused"
        ? { kind: "refused", reason: created.reason }
        : { kind: "failed", reason: created.reason }
    ) satisfies LinkResult;
  }

  const link = await answeringStripe(what, () => LinkWithId.parse(created.value));

  return (
    link.kind === "ok"
      ? { id: link.value.id, kind: "made", url: link.value.url }
      : { kind: "unrecorded" }
  ) satisfies LinkResult;
};

/** The query parameter a buyer lands back on the product with, naming their checkout session. */
export const CHECKOUT_SESSION_PARAM = "session_id";

const withCheckoutSession = (page: string) => {
  const url = new URL(page);
  const query = url.search === "" ? "?" : `${url.search}&`;

  return `${url.origin}${url.pathname}${query}${CHECKOUT_SESSION_PARAM}={CHECKOUT_SESSION_ID}${url.hash}`;
};

const afterCompletion = (page: string | null) =>
  (page === null
    ? {}
    : {
        "after_completion[redirect][url]": withCheckoutSession(page),
        "after_completion[type]": "redirect",
      }) satisfies Record<string, string>;

const underKey = (prefix: string, tags: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.entries(tags).map(([key, value]) => [`${prefix}[${key}]`, value]));

const MAX_KEYS_PASSED = 20;

const replayedIn = (headers: Headers) => headers.get("Idempotent-Replayed") === "true";

const Switched = z.object({ active: z.boolean() });

const switchedOffSince = (key: string) => async (replayed: JsonValue) => {
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

const idempotentPost =
  (key: string, owner: readonly string[]) =>
  (
    path: string,
    form: Readonly<Record<string, string>>,
    dead: (replayed: JsonValue) => Promise<boolean> = () => Promise.resolve(false),
  ) => {
    const digest = createHash("sha256")
      .update(JSON.stringify([...owner, path, form]))
      .digest("hex");

    const send = async (attempt: number) => {
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

const variantChoice = (variants: readonly ListingVariant[]) =>
  (variants.length < 2
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
      }) satisfies Record<string, string>;

/** Whether Stripe lets a key make the reads asked, which a restricted key needs granted each on its own. */
export type StripeAccess =
  | { kind: "granted" }
  | { kind: "refused"; reason: string }
  | { kind: "unreachable"; reason: string };

const accessTo = async (key: string, reads: readonly string[]) => {
  const asked = await answeringStripe("access", async () => {
    for (const read of reads) {
      await getJson(`${STRIPE_API}${read}`, stripeHeaders(key));
    }
  });

  if (asked.kind === "ok") {
    return { kind: "granted" } satisfies StripeAccess;
  }

  return (
    asked.kind === "refused"
      ? { kind: "refused", reason: asked.reason }
      : { kind: "unreachable", reason: asked.reason }
  ) satisfies StripeAccess;
};

const CHECKOUTS = "/v1/checkout/sessions?limit=1";

/**
 * Whether `key` reaches what a print sells through, asked before the founder signs off on a
 * listing, so a restricted key is fixed first rather than leave paid orders unsent: the shipping
 * rates a listing makes, the checkout sessions each order is found by, and the charges that show
 * its payment still stands before Printful is paid. Write implies read, so this catches a key
 * with no grant on shipping rates, not one granted Read alone.
 */
export const stripeListingAccess = (key: string) =>
  accessTo(key, ["/v1/shipping_rates?limit=1", CHECKOUTS, "/v1/charges?limit=1"]);

/**
 * Whether `key` reaches payment links, asked before the founder signs off on one, so a key rolled,
 * revoked or expired since it was saved is replaced first rather than spend the sign-off. Write
 * implies read, so this is the read every key that can make a link has.
 */
export const stripeLinkAccess = (key: string) => accessTo(key, ["/v1/payment_links?limit=1"]);

/** Whether `key` reads checkout sessions, which is how each buyer a link owes a delivery is found. */
export const stripeCheckoutAccess = (key: string) => accessTo(key, [CHECKOUTS]);

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

type SwitchOffResult =
  | { kind: "off" }
  | { kind: "refused"; reason: string }
  | { kind: "unanswered"; reason: string };

/** Its URL then shows the buyer the link is deactivated. Asking again of a link already off answers the same. */
export const switchOffPaymentLink = async (key: string, id: string) => {
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
      return (
        answer.value.active
          ? { kind: "refused", reason: "Stripe still lists it as active" }
          : { kind: "off" }
      ) satisfies SwitchOffResult;
    }

    case "down": {
      return { kind: "unanswered", reason: answer.reason } satisfies SwitchOffResult;
    }

    case "refused":
    case "missing":
    case "rejected": {
      return { kind: "refused", reason: answer.reason } satisfies SwitchOffResult;
    }

    default: {
      return unreachable(answer);
    }
  }
};
