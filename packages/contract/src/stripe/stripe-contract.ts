// The founder's Stripe: the read-only connection that counts revenue, and the key that charges.

import { oc, type } from "@orpc/contract";
import type { StripeKeyStatus, StripeStatus } from "@repo/domain/integrations";
import type { Done } from "../done";
import { saveKeyInput } from "./stripe-schema";

export const stripeContract = {
  /** Starts the connection in the browser; its outcome arrives as a `stripe` event. */
  connect: oc.output(type<{ started: boolean }>()),
  disconnect: oc.output(type<Done>()),
  keyStatus: oc.output(type<StripeKeyStatus>()),
  removeKey: oc.output(type<Done>()),
  saveKey: oc.input(saveKeyInput).output(type<Done>()),
  status: oc.output(type<StripeStatus>()),
};
