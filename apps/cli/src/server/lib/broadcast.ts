import { CHANNELS } from "@repo/contract/ipc-channels";
import type { IpcMethod } from "@repo/contract/ipc-channels";
import type { Contract } from "@repo/contract/ipc-registry";
import { parseJson } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";

type EventMethod = {
  [M in IpcMethod]: (typeof CHANNELS)[M]["kind"] extends "event" ? M : never;
}[IpcMethod];

/** Where an event goes: the host, which hands it to the window under its channel. */
type EventSink = (channel: string, data: JsonValue) => void;

let sink: EventSink | null = null;

export const setEventSink = (next: EventSink): void => {
  sink = next;
};

/** Tells the window, if one is listening; before the host says hello there is none. */
export const broadcast = <M extends EventMethod>(method: M, data: Contract[M]["result"]): void => {
  sink?.(CHANNELS[method].channel, parseJson(JSON.stringify(data)));
};
