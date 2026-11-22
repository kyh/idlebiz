import { unreachable } from "@repo/domain/errors";
import type { PageEvent, PageEventName, PageEvents } from "@repo/contract/events";
import { api } from "@/renderer/api";
import { reportFault } from "@/renderer/report-fault";

type Listener<E extends PageEventName> = (data: PageEvents[E]) => void;

type Listeners = { [E in PageEventName]: Set<Listener<E>> };

const listeners: Listeners = {
  activity: new Set(),
  auth: new Set(),
  opening: new Set(),
  update: new Set(),
};

/** Hears one of main's events until the function it returns is called. */
export const listen = <E extends PageEventName>(name: E, listener: Listener<E>) => {
  const heard = listeners[name];
  heard.add(listener);

  return (() => {
    heard.delete(listener);
  }) satisfies () => void;
};

const tell = <E extends PageEventName>(name: E, data: PageEvents[E]) => {
  for (const listener of listeners[name]) {
    try {
      listener(data);
    } catch (error) {
      console.error(`Could not apply main's ${name} event`, error);
      reportFault(`event:${name}`, error);
    }
  }
};

const hear = (event: PageEvent) => {
  switch (event.name) {
    case "activity": {
      tell(event.name, event.data);
      break;
    }

    case "auth": {
      tell(event.name, event.data);
      break;
    }

    case "opening": {
      tell(event.name, event.data);
      break;
    }

    case "update": {
      tell(event.name, event.data);
      break;
    }

    default: {
      return unreachable(event);
    }
  }
};

const RETRY_MS = 1000;

const retryPause = () =>
  // oxlint-disable-next-line promise/avoid-new -- wraps a timer
  new Promise<void>((resolve) => {
    setTimeout(resolve, RETRY_MS);
  });

/**
 * Hears main's events for as long as the page is open. `resync` asks main for everything again
 * once each stream but the first is open, since what main sent while none was open is lost. Open
 * first: main then hears the page before it answers, so nothing it does after an answer is lost.
 * The first stream opens beside the window's own first reads (docs/app.md).
 */
export const hearMain = (resync: () => void) => {
  void (async () => {
    let reopened = false;

    for (;;) {
      try {
        const events = await api.events();

        if (reopened) {
          resync();
        }

        for await (const event of events) {
          hear(event);
        }
      } catch (error) {
        console.error("Lost main's events", error);
      }

      reopened = true;
      await retryPause();
    }
  })();
};
