import { createHash } from "node:crypto";
import { printfulCatalog, printfulQuote } from "@/main/printful";
import type { CatalogReader, PrintQuote, PrintQuoter } from "@/main/printful";
import { stripeShippedLink, stripeShippingAccess } from "@/main/payment-links";
import type { ShippedLinker, StripeAccess } from "@/main/payment-links";
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

// long enough to read a large print file, short enough that a site streaming forever cannot
// hold the call
const FILE_TIMEOUT_MS = 60_000;

/** A print file as the product serves it now: the digest of its bytes, or why Printful could not print it. */
export type PrintFileRead = { kind: "image"; sha256: string } | { kind: "unfit"; reason: string };

/**
 * Read `url` as Printful will, and hash what it serves, so the founder signs off on those bytes
 * rather than on a URL a later deploy could fill with another design. No redirect is followed:
 * a file on the product's own domain needs none, and a single-page app answers any path with
 * its page, which is why the type is read too.
 */
export const readPrintFile = async (url: string): Promise<PrintFileRead> => {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });
    if (res.status !== 200 || res.body === null) {
      await res.body?.cancel();
      return { kind: "unfit", reason: `it answers ${res.status}` };
    }
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) {
      await res.body.cancel();
      return { kind: "unfit", reason: `it serves ${type || "no content type"}, not an image` };
    }
    const hash = createHash("sha256");
    const reader = res.body.getReader();
    let chunk = await reader.read();
    while (!chunk.done) {
      // fetch types a body's chunks as any, though it only ever streams bytes
      if (!(chunk.value instanceof Uint8Array)) {
        throw new TypeError("the file's body is not bytes");
      }
      hash.update(chunk.value);
      chunk = await reader.read();
    }
    return { kind: "image", sha256: hash.digest("hex") };
  } catch (error) {
    return { kind: "unfit", reason: errorMessage(error) };
  }
};

/** What listing a print-on-demand item takes from outside: Vercel's domains, the file, Printful's catalog and price, Stripe's grant and link. */
export interface PrintListing {
  hosts: typeof productionHosts;
  readFile: (url: string) => Promise<PrintFileRead>;
  catalog: CatalogReader;
  quote: PrintQuoter;
  shippingAccess: (key: string) => Promise<StripeAccess>;
  publish: ShippedLinker;
}

export const printListing: PrintListing = {
  catalog: printfulCatalog,
  hosts: productionHosts,
  publish: stripeShippedLink,
  quote: printfulQuote,
  readFile: readPrintFile,
  shippingAccess: stripeShippingAccess,
};
