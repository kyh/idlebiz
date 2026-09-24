import { z } from "zod";
import { HttpError, postForm } from "@/main/lib/http";
import { STRIPE_VERSION } from "@/main/metrics";
import { errorMessage } from "@/shared/errors";

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
const Refusal = z.object({ error: z.object({ message: z.string() }) });

/** Each tag as a form field under `prefix`, the way Stripe reads a map. */
const underKey = (prefix: string, tags: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(tags).map(([key, value]) => [`${prefix}[${key}]`, value]));

/** A payment link made on Stripe here in main, so an employee's process never holds the key. */
export const stripePaymentLink: PaymentLinker = async ({ key, name, cents, product, bet }) => {
  const headers = { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION };
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
    const said = error instanceof HttpError ? Refusal.safeParse(error.answer) : null;
    return { error: said?.success ? said.data.error.message : errorMessage(error), ok: false };
  }
};
