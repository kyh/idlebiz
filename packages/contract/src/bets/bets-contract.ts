// The bets that steer the company: the list, and the founder's kill.

import { oc, type } from "@orpc/contract";
import type { Bet } from "@repo/domain/bets";
import { killBetInput } from "./bets-schema";

export const betsContract = {
  /** Kills a bet by hand. */
  kill: oc.input(killBetInput).output(type<Bet>()),
  list: oc.output(type<Bet[]>()),
};
