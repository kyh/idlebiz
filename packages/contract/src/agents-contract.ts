// The CLIs employees run on: whether any is signed in, a sign-in, and who waits on one.

import { oc, type } from "@orpc/contract";
import type { RestingRunners } from "@repo/domain/domain";
import type { RunnerId } from "@repo/domain/runners";
import type { Done } from "./done";

export const agentsContract = {
  /** Stops the setup under way, which ends in an `auth` error; with none, that error says so. */
  cancelLogin: oc.output(type<Done>()),
  /** Whether any CLI is signed in, and the runners that are not, whose employees wait on a sign-in. */
  hasAuth: oc.output(type<{ ok: boolean; signedOut: RunnerId[] }>()),
  /** The runners parked on a usage limit, and when each lifts. */
  resting: oc.output(type<RestingRunners>()),
  /** Starts the setup of a CLI (detect, install, sign in); its steps arrive as `auth` events. */
  startLogin: oc.output(type<{ started: boolean }>()),
};
