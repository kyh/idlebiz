import { printfulQuote } from "@/main/printful";
import type { PrintQuote, PrintQuoter } from "@/main/printful";
import { stripeShippedLink } from "@/main/payment-links";
import type { ShippedLinker } from "@/main/payment-links";
import { productionHosts } from "@/main/vercel";
import { errorMessage } from "@/shared/errors";

// Stripe keeps 2.9% + 30¢ of a US card payment, and 1.5% more of a card issued abroad, which a
// US shipping address does not rule out. What the buyer pays, the price plus the shipping the
// link charges, has to cover Printful's dearest estimate (print, shipping and tax to any sampled
// US address) once Stripe has taken its share:
//   (price + shipping) × (1 − 4.4%) − 30¢ ≥ cost
//   price ≥ (cost + 30¢) / (1 − 4.4%) − shipping
const STRIPE_SHARE = 0.044;
const STRIPE_FIXED_CENTS = 30;

/** The lowest price, in cents, at which a sale loses nothing. */
export const priceFloorCents = ({ costCents, shippingCents }: PrintQuote): number =>
  Math.ceil((costCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_SHARE)) - shippingCents;

const FILE_TIMEOUT_MS = 10_000;

/**
 * Why Printful could not fetch `url` as a print file, or null when it serves an image now. No
 * redirect is followed: a file on the product's own domain needs none, and a single-page app
 * answers any path with its page, which is why the type is read too.
 */
export const printFileProblem = async (url: string): Promise<string | null> => {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      return `it answers ${res.status}`;
    }
    const type = res.headers.get("content-type") ?? "";
    return type.startsWith("image/")
      ? null
      : `it serves ${type || "no content type"}, not an image`;
  } catch (error) {
    return errorMessage(error);
  }
};

/** What listing a print-on-demand item takes from outside: Vercel's domains, the file, Printful's price, Stripe's link. */
export interface PrintListing {
  hosts: typeof productionHosts;
  fileProblem: (url: string) => Promise<string | null>;
  quote: PrintQuoter;
  publish: ShippedLinker;
}

export const printListing: PrintListing = {
  fileProblem: printFileProblem,
  hosts: productionHosts,
  publish: stripeShippedLink,
  quote: printfulQuote,
};
