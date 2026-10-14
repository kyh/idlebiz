// The bets that steer the company: the list, and the founder's kill.

import { oc, type } from "@orpc/contract";
import { z } from "zod";
import type { Bet } from "@repo/domain/bets";
import { KillReasonSchema } from "@repo/domain/domain";

export const betsContract = {
  /** Kills a bet by hand. */
  kill: oc.input(z.object({ betId: z.string(), reason: KillReasonSchema })).output(type<Bet>()),
  list: oc.output(type<Bet[]>()),
};
