// The save itself: what boot made of it, its folder, and the reset that deletes it.

import { oc, type } from "@orpc/contract";
import type { LoadReport } from "@repo/domain/domain";
import type { Done } from "../done";

export const saveContract = {
  openFolder: oc.output(type<Done>()),
  /** What boot loaded and what it skipped, the seal's refusal among it. */
  report: oc.output(type<LoadReport>()),
  /** Deletes the save and starts the app again. */
  reset: oc.output(type<Done>()),
};
