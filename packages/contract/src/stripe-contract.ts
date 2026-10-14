// The founder's Stripe key: it charges, and it reads the revenue it brings in.

import { oc, type } from "@orpc/contract";
import { z } from "zod";
import type { StripeKeyStatus } from "@repo/domain/integrations";
import type { Done } from "./done";

export const stripeContract = {
  keyStatus: oc.output(type<StripeKeyStatus>()),
  removeKey: oc.output(type<Done>()),
  saveKey: oc.input(z.object({ key: z.string().trim().min(1) })).output(type<Done>()),
};
