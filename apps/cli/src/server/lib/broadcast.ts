import { MemoryPublisher } from "@orpc/publisher/memory";
import { PageEventSchema } from "@repo/contract/events";
import type { PageEvent, PageEventName, PageEvents } from "@repo/contract/events";
import { report } from "./report";

const publisher = new MemoryPublisher<{ page: PageEvent }>({ maxBufferedEvents: Infinity });

/** Tells every page listening; before one subscribes there is none. */
export const broadcast = <E extends PageEventName>(name: E, data: PageEvents[E]) => {
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
