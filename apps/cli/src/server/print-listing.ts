import { createHash } from "node:crypto";
import type { PrintQuote } from "./printful";
import { errorMessage } from "@repo/domain/errors";
import { formatCents } from "@repo/domain/format";

const STRIPE_SHARE = 0.044;
const STRIPE_FIXED_CENTS = 30;

/** Stripe's dearest fee on a payment, as the agent and the founder read it. */
export const STRIPE_FEE_LABEL = `${(STRIPE_SHARE * 100).toFixed(1)}% + ${formatCents(STRIPE_FIXED_CENTS)}`;

/** What is left of a payment, in cents, once Stripe has taken its dearest fee. */
export const netOfStripeCents = (collectedCents: number) =>
  Math.floor(collectedCents * (1 - STRIPE_SHARE)) - STRIPE_FIXED_CENTS;

/**
 * The lowest price, in cents, at which a sale costing the quote loses nothing. Tax on the price
 * itself only rises with it, so every price under this one loses money.
 */
export const priceFloorCents = ({ costCents, shippingCents }: PrintQuote) =>
  Math.ceil((costCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_SHARE)) - shippingCents;

const FILE_TIMEOUT_MS = 60_000;

/** A print file as the product serves it now: the digest of its bytes, or why Printful could not print it. */
export type PrintFileRead = { kind: "image"; sha256: string } | { kind: "unfit"; reason: string };

/**
 * Read `url` as Printful will, and hash what it serves, so the founder signs off on those bytes
 * rather than on a URL a later deploy could fill with another design. No redirect is followed:
 * a file on the product's own domain needs none, and a single-page app answers any path with
 * its page, which is why the type is read too.
 */
export const readPrintFile = async (url: string) => {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FILE_TIMEOUT_MS),
    });

    if (res.status !== 200 || res.body === null) {
      await res.body?.cancel();

      return { kind: "unfit", reason: `it answers ${res.status}` } satisfies PrintFileRead;
    }

    const type = res.headers.get("content-type") ?? "";

    if (!type.startsWith("image/")) {
      await res.body.cancel();

      return {
        kind: "unfit",
        reason: `it serves ${type || "no content type"}, not an image`,
      } satisfies PrintFileRead;
    }

    const hash = createHash("sha256");
    const reader = res.body.getReader();
    let chunk = await reader.read();

    while (!chunk.done) {
      if (!(chunk.value instanceof Uint8Array)) {
        throw new TypeError("the file's body is not bytes");
      }

      hash.update(chunk.value);
      chunk = await reader.read();
    }

    return { kind: "image", sha256: hash.digest("hex") } satisfies PrintFileRead;
  } catch (error) {
    return { kind: "unfit", reason: errorMessage(error) } satisfies PrintFileRead;
  }
};
