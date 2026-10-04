// The CLIs employees run on: whether any is signed in, a sign-in, and who waits on one.

import { oc, type } from "@orpc/contract";
import type { AgentRunner, RestingRunners } from "@repo/domain/domain";

export const agentsContract = {
  /** Whether any CLI is signed in, and the runners that are not, whose employees wait on a sign-in. */
  hasAuth: oc.output(type<{ ok: boolean; signedOut: AgentRunner[] }>()),
  /** The runners parked on a usage limit, and when each lifts. */
  resting: oc.output(type<RestingRunners>()),
  /** Starts the setup of a CLI (detect, install, sign in); its steps arrive as `auth` events. */
  startLogin: oc.output(type<{ started: boolean }>()),
};
