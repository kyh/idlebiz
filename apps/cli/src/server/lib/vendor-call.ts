import { z } from "zod";
import { errorMessage } from "@repo/domain/errors";
import { HttpError } from "./http";
import { report } from "./report";

// How a call to Stripe's or Printful's API failed, sorted once here: each caller folds the answer
// into what it acts on. An answer its schema refuses is the vendor changing its shape, which no
// caller can act on, so it is kept in main's log as well.

/**
 * How a vendor's call failed. `refused` is the credential turned away (401: not one the vendor
 * knows; 403: not granted this call), which only another fixes; `missing` a 404; `rejected` a
 * refusal asking again cannot change, such as an address Printful cannot ship to; `down` no
 * answer to act on, which a later call may get past. `reason` is why, in the vendor's words
 * when it gave any.
 */
export type VendorFault =
  | { kind: "refused"; status: 401 | 403; reason: string }
  | { kind: "missing"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "down"; reason: string };

/** How a vendor answered a call: what it sent, or how the call failed. */
export type VendorAnswer<T> = { kind: "ok"; value: T } | VendorFault;

const faultOf = (error: HttpError, reason: string): VendorFault => {
  if (error.refused) {
    return { kind: "refused", reason, status: error.status === 401 ? 401 : 403 };
  }
  if (error.status === 404) {
    return { kind: "missing", reason };
  }
  // a 429 is the vendor busy, which a later call gets past, not a refusal
  const permanent = error.status >= 400 && error.status < 500 && error.status !== 429;
  return { kind: permanent ? "rejected" : "down", reason };
};

/**
 * Run `what`, a call of `vendor`'s, answering its failure as the caller acts on it, in the words
 * `says` reads off the vendor's refusal. An answer the call's schemas refuse is reported under
 * the call it answered.
 */
export const answering = async <T>(
  vendor: string,
  what: string,
  call: () => Promise<T> | T,
  says: (error: HttpError) => string,
): Promise<VendorAnswer<T>> => {
  try {
    return { kind: "ok", value: await call() };
  } catch (error) {
    if (error instanceof HttpError) {
      return faultOf(error, says(error));
    }
    if (error instanceof z.ZodError) {
      report(`${vendor} ${what}`, error);
      return {
        kind: "down",
        reason: `${vendor} answered in a shape IdleBiz does not read, which a change on ${vendor}'s side causes; try again later`,
      };
    }
    return { kind: "down", reason: errorMessage(error) };
  }
};
