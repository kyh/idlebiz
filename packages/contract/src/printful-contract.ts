// The founder's Printful token, which prints and ships what the company sells.

import { oc, type } from "@orpc/contract";
import { z } from "zod";
import type { PrintfulTokenStatus } from "@repo/domain/integrations";
import type { Done } from "./done";

export const printfulContract = {
  removeToken: oc.output(type<Done>()),
  saveToken: oc.input(z.object({ token: z.string().trim().min(1) })).output(type<Done>()),
  tokenStatus: oc.output(type<PrintfulTokenStatus>()),
};
