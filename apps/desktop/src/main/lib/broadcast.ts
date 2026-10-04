import { CHANNELS } from "@/shared/ipc-channels";
import type { IpcMethod } from "@/shared/ipc-channels";
import type { Contract } from "@/shared/ipc-registry";
import { parseJson } from "@/shared/json";
import type { JsonValue } from "@/shared/json";

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
