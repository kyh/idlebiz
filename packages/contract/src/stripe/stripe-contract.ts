// The founder's Stripe key: it charges, and it reads the revenue it brings in.

import { oc, type } from "@orpc/contract";
import type { StripeKeyStatus } from "@repo/domain/integrations";
import type { Done } from "../done";
import { saveKeyInput } from "./stripe-schema";

export const stripeContract = {
  keyStatus: oc.output(type<StripeKeyStatus>()),
  removeKey: oc.output(type<Done>()),
  saveKey: oc.input(saveKeyInput).output(type<Done>()),
};
