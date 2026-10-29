// Main's events as the page hears them: the contract's one stream, reopened whenever it drops.

import type { PageEvent, PageEventName, PageEvents } from "@repo/contract/events";
import { api } from "@/renderer/api";

type Listener<E extends PageEventName> = (data: PageEvents[E]) => void;

/** Who hears each event, by its name. */
type Listeners = { [E in PageEventName]: Set<Listener<E>> };

const listeners: Listeners = {
  activity: new Set(),
  auth: new Set(),
  update: new Set(),
};

/** Hears one of main's events until the function it returns is called. */
export const listen = <E extends PageEventName>(name: E, listener: Listener<E>): (() => void) => {
  const heard = listeners[name];
  heard.add(listener);
  return () => {
    heard.delete(listener);
  };
};

// one listener's fault is its own: the others still hear the event, and the stream stays open
const tell = <E extends PageEventName>(name: E, data: PageEvents[E]): void => {
  for (const listener of listeners[name]) {
    try {
      listener(data);
    } catch (error) {
      console.error(`Could not apply main's ${name} event`, error);
    }
  }
};

// the same call in each case: only a narrowed event pairs a name with the data it carries
const hear = (event: PageEvent): void => {
  switch (event.name) {
    case "activity": {
      tell(event.name, event.data);
      break;
    }
    case "auth": {
      tell(event.name, event.data);
      break;
    }
    case "update": {
      tell(event.name, event.data);
      break;
    }
    // no default
  }
};

/** Between one stream dropping and the next, so a main that keeps refusing it is not hammered. */
const RETRY_MS = 1000;

const retryPause = (): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- wraps a timer
  new Promise((resolve) => {
    setTimeout(resolve, RETRY_MS);
  });

/**
 * Hears main's events for as long as the page is open. `resync` asks main for everything again,
 * and runs just before each stream opens, the first included: it is what the page missed meanwhile.
 */
export const hearMain = (resync: () => void): void => {
  void (async () => {
    for (;;) {
      resync();
      try {
        for await (const event of await api.events()) {
          hear(event);
        }
      } catch (error) {
        console.error("Lost main's events", error);
      }
      await retryPause();
    }
  })();
};
