// The founder's Printful token, which prints and ships what the company sells.

import { oc, type } from "@orpc/contract";
import type { PrintfulTokenStatus } from "@repo/domain/integrations";
import type { Done } from "../done";
import { saveTokenInput } from "./printful-schema";

export const printfulContract = {
  removeToken: oc.output(type<Done>()),
  saveToken: oc.input(saveTokenInput).output(type<Done>()),
  tokenStatus: oc.output(type<PrintfulTokenStatus>()),
};
