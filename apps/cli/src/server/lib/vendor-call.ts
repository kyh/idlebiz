import { z } from "zod";
import { errorMessage } from "@repo/domain/errors";
import { HttpError } from "./http";
import { report } from "./report";

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

export type VendorAnswer<T> = { kind: "ok"; value: T } | VendorFault;

const faultOf = (error: HttpError, reason: string) => {
  if (error.refused) {
    return {
      kind: "refused",
      reason,
      status: error.status === 401 ? 401 : 403,
    } satisfies VendorFault;
  }

  if (error.status === 404) {
    return { kind: "missing", reason } satisfies VendorFault;
  }

  const permanent = error.status >= 400 && error.status < 500 && error.status !== 429;

  return { kind: permanent ? "rejected" : "down", reason } satisfies VendorFault;
};

/**
 * Run `call`, answering its failure in the words `says` reads off `vendor`'s refusal; each caller
 * folds the answer into what it acts on. An answer the call's schemas refuse is the vendor
 * changing its shape, which no caller can act on, so main's log keeps it too.
 */
export const answering = async <T>(
  vendor: string,
  what: string,
  call: () => Promise<T> | T,
  says: (error: HttpError) => string,
) => {
  try {
    return { kind: "ok", value: await call() } satisfies VendorAnswer<T>;
  } catch (error) {
    if (error instanceof HttpError) {
      return faultOf(error, says(error));
    }

    if (error instanceof z.ZodError) {
      report(`${vendor} ${what}`, error);

      return {
        kind: "down",
        reason: `${vendor} answered in a shape IdleBiz does not read, which a change on ${vendor}'s side causes; try again later`,
      } satisfies VendorAnswer<T>;
    }

    return { kind: "down", reason: errorMessage(error) } satisfies VendorAnswer<T>;
  }
};
