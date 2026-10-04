// What the server tells the page as it happens, on one server-sent stream (EVENTS_PATH), each
// event under its name. The page holds no state the server has not answered: an event says which
// slice moved, and the page asks again (apps/desktop/src/renderer/state/activity-reducer.ts).

import type { ActivityEvent } from "@repo/domain/activity";
import type { AuthFlowEvent } from "@repo/domain/domain";
import type { StripeStatus } from "@repo/domain/integrations";

export interface PageEvents {
  /** A step of the company's activity: a run, a task, a bet, a line in the room. */
  activity: ActivityEvent;
  /** A step of a CLI's sign-in the founder started (`agents.startLogin`). */
  auth: AuthFlowEvent;
  /** Where the Stripe connection stands, once its browser step settles. */
  stripe: StripeStatus;
}

export type PageEvent = keyof PageEvents;

export const PAGE_EVENTS = ["activity", "auth", "stripe"] as const satisfies readonly PageEvent[];
