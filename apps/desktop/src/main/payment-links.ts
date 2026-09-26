import { z } from "zod";
import { HttpError, postForm } from "@/main/lib/http";
import { STRIPE_VERSION } from "@/main/metrics";
import { errorMessage } from "@/shared/errors";
import type { ListingVariant } from "@/shared/listing";

/** One price in USD, sold once through a link whose every payment carries the product's tag and, when named, the bet's. */
interface PaymentLinkRequest {
  key: string;
  name: string;
  cents: number;
  product: string;
  bet: string | null;
}

/** `error` is why no link was made, in Stripe's words when it gave any. */
type PaymentLinkResult = { ok: true; url: string } | { ok: false; error: string };

export type PaymentLinker = (req: PaymentLinkRequest) => Promise<PaymentLinkResult>;

const API = "https://api.stripe.com";

const Created = z.object({ id: z.string() });
const Link = z.object({ url: z.url() });
const LinkWithId = z.object({ id: z.string(), url: z.url() });
const Refusal = z.object({ error: z.object({ message: z.string() }) });

/** Each tag as a form field under `prefix`, the way Stripe reads a map. */
const underKey = (prefix: string, tags: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(tags).map(([key, value]) => [`${prefix}[${key}]`, value]));

const headersFor = (key: string) => ({
  Authorization: `Bearer ${key}`,
  "Stripe-Version": STRIPE_VERSION,
});

/** Why Stripe refused, in its words when it gave any. */
const stripeSays = (error: HttpError): string => {
  const said = Refusal.safeParse(error.answer);
  return said.success ? said.data.error.message : error.message;
};

/** A payment link made on Stripe here in main, so an employee's process never holds the key. */
export const stripePaymentLink: PaymentLinker = async ({ key, name, cents, product, bet }) => {
  const headers = headersFor(key);
  const tags: Record<string, string> = bet === null ? { product } : { bet, product };
  try {
    const price = Created.parse(
      await postForm(`${API}/v1/prices`, headers, {
        currency: "usd",
        "product_data[name]": name,
        unit_amount: String(cents),
      }),
    );
    const link = Link.parse(
      await postForm(`${API}/v1/payment_links`, headers, {
        "line_items[0][price]": price.id,
        "line_items[0][quantity]": "1",
        // the charge the app counts copies its payment's metadata, never the link's;
        // the link's own tags are how the founder finds it in Stripe
        ...underKey("metadata", tags),
        ...underKey("payment_intent_data[metadata]", tags),
      }),
    );
    return { ok: true, url: link.url };
  } catch (error) {
    return {
      error: error instanceof HttpError ? stripeSays(error) : errorMessage(error),
      ok: false,
    };
  }
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

type ShippedLinkResult = { ok: true; id: string; url: string } | { ok: false; error: string };

export type ShippedLinker = (req: ShippedLinkRequest) => Promise<ShippedLinkResult>;

/** The custom field a buyer picks the variant in; fulfilment reads the choice back by it. */
const VARIANT_FIELD = "variant";

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

/**
 * A print-on-demand item's payment link, tagged like any other so its money counts for the
 * product and the bet, and for the listing, so each paid order can be sent to Printful.
 */
export const stripeShippedLink: ShippedLinker = async (req) => {
  const { bet, key, listing, name, priceCents, product, shippingCents, variants } = req;
  const headers = headersFor(key);
  const tags: Record<string, string> =
    bet === null ? { listing, product } : { bet, listing, product };
  try {
    const price = Created.parse(
      await postForm(`${API}/v1/prices`, headers, {
        currency: "usd",
        "product_data[name]": name,
        unit_amount: String(priceCents),
      }),
    );
    const rate = Created.parse(
      await postForm(`${API}/v1/shipping_rates`, headers, {
        display_name: "Standard shipping",
        "fixed_amount[amount]": String(shippingCents),
        "fixed_amount[currency]": "usd",
        type: "fixed_amount",
      }),
    );
    const link = LinkWithId.parse(
      await postForm(`${API}/v1/payment_links`, headers, {
        "line_items[0][price]": price.id,
        "line_items[0][quantity]": "1",
        "shipping_address_collection[allowed_countries][0]": "US",
        "shipping_options[0][shipping_rate]": rate.id,
        ...variantChoice(variants),
        ...underKey("metadata", tags),
        ...underKey("payment_intent_data[metadata]", tags),
      }),
    );
    return { id: link.id, ok: true, url: link.url };
  } catch (error) {
    return {
      error: error instanceof HttpError ? stripeSays(error) : errorMessage(error),
      ok: false,
    };
  }
};
