import type { PageEvent, PageEvents } from "@repo/contract/events";
import { parseJson } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";

/** Where an event goes: the page server, which streams it to every page listening. */
type EventSink = (event: PageEvent, data: JsonValue) => void;

let sink: EventSink | null = null;

export const setEventSink = (next: EventSink): void => {
  sink = next;
};

/** Tells the page, if one is listening; before the page server is up there is none. */
export const broadcast = <E extends PageEvent>(event: E, data: PageEvents[E]): void => {
  sink?.(event, parseJson(JSON.stringify(data)));
};
