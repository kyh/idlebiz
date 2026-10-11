// Main's events for the page, which hears them on the contract's `events` stream (page-router.ts).
// Each is parsed as it is published: the stream checks every event it sends too, and one that
// fails there ends the stream for every page, so a malformed event is logged and dropped here.

import { MemoryPublisher } from "@orpc/publisher/memory";
import { PageEventSchema } from "@repo/contract/events";
import type { PageEvent, PageEventName, PageEvents } from "@repo/contract/events";
import { report } from "./report";

// unbounded, as a socket's write buffer is: an event a slow page drops is a slice it never asks for again
const publisher = new MemoryPublisher<{ page: PageEvent }>({ maxBufferedEvents: Infinity });

/** Tells every page listening; before one subscribes there is none. */
export const broadcast = <E extends PageEventName>(name: E, data: PageEvents[E]): void => {
  const parsed = PageEventSchema.safeParse({ data, name });
  if (!parsed.success) {
    report(`page event ${name}`, parsed.error);
    return;
  }
  void publisher.publish("page", parsed.data);
};

/** Every event published from now until `signal` aborts: one page's stream. */
export const pageEvents = (signal: AbortSignal | undefined) =>
  publisher.subscribe("page", { signal });
