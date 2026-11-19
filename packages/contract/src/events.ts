import { z } from "zod";
import { ActivityEventSchema } from "@repo/domain/activity";
import { AuthFlowEventSchema, UpdateStatusSchema } from "@repo/domain/domain";

export const PageEventSchema = z.discriminatedUnion("name", [
  z.object({ data: ActivityEventSchema, name: z.literal("activity") }),
  z.object({ data: AuthFlowEventSchema, name: z.literal("auth") }),
  z.object({ data: UpdateStatusSchema, name: z.literal("update") }),
]);

export type PageEvent = z.infer<typeof PageEventSchema>;

export type PageEventName = PageEvent["name"];

/** What each event carries, by its name. */
export type PageEvents = { [E in PageEventName]: Extract<PageEvent, { name: E }>["data"] };
