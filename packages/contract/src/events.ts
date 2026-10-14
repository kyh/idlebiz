import { z } from "zod";
import { ActivityEventSchema } from "@repo/domain/activity";
import { AuthFlowEventSchema } from "@repo/domain/domain";

export const PageEventSchema = z.discriminatedUnion("name", [
  /** A step of the company's activity: a run, a task, a bet, a line in the room. */
  z.object({ data: ActivityEventSchema, name: z.literal("activity") }),
  /** A step of a CLI's sign-in the founder started (`agents.startLogin`). */
  z.object({ data: AuthFlowEventSchema, name: z.literal("auth") }),
]);

export type PageEvent = z.infer<typeof PageEventSchema>;

export type PageEventName = PageEvent["name"];

/** What each event carries, by its name. */
export type PageEvents = { [E in PageEventName]: Extract<PageEvent, { name: E }>["data"] };
