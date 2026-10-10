// What the server tells the page as it happens, on the contract's one stream (`events`), each
// event under its name. The page holds no state the server has not answered: an event says which
// slice moved, and the page asks again (apps/desktop/src/renderer/state/activity-reducer.ts).

import { z } from "zod";
import { ActivityEventSchema } from "@repo/domain/activity";
import { AuthFlowEventSchema } from "@repo/domain/domain";
import { StripeStatusSchema } from "@repo/domain/integrations";

export const PageEventSchema = z.discriminatedUnion("name", [
  /** A step of the company's activity: a run, a task, a bet, a line in the room. */
  z.object({ data: ActivityEventSchema, name: z.literal("activity") }),
  /** A step of a CLI's sign-in the founder started (`agents.startLogin`). */
  z.object({ data: AuthFlowEventSchema, name: z.literal("auth") }),
  /** Where the Stripe connection stands, once its browser step settles. */
  z.object({ data: StripeStatusSchema, name: z.literal("stripe") }),
]);

export type PageEvent = z.infer<typeof PageEventSchema>;

export type PageEventName = PageEvent["name"];

/** What each event carries, by its name. */
export type PageEvents = { [E in PageEventName]: Extract<PageEvent, { name: E }>["data"] };
