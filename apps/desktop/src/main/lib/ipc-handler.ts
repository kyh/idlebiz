import { ipcMain } from "electron";
import type { WebFrameMain } from "electron";
import type { z } from "zod";
import { settle } from "@/main/lib/ipc-reply";
import { CHANNELS } from "@/shared/ipc-channels";
import type { InvokeMethod, WireValue } from "@/shared/ipc-channels";
import { SCHEMAS } from "@/shared/ipc-registry";
import type { Contract, IpcHandler } from "@/shared/ipc-registry";

const SCHEMA_MAP: { [M in InvokeMethod]: z.ZodType<Contract[M]["payload"]> } = SCHEMAS;

const INVOKE_METHODS = Object.keys(SCHEMAS).filter((m): m is InvokeMethod => m in SCHEMAS);

/** One handler per invoke method: a channel without one fails to compile. */
export type IpcHandlers = { [M in InvokeMethod]: IpcHandler<M> };

/** Only the app's own window may call main: its top frame, never a frame something embedded. */
const fromOurWindow = (frame: WebFrameMain | null): boolean =>
  frame !== null && frame.parent === null;

// Generic so handlers[method] narrows to IpcHandler<M>; over the union it would not.
const handle = <M extends InvokeMethod>(handlers: IpcHandlers, method: M): void => {
  const fn = handlers[method];
  ipcMain.handle(CHANNELS[method].channel, (event, raw: WireValue) => {
    if (!fromOurWindow(event.senderFrame)) {
      throw new Error(`[ipc:${method}] refused: not the app's own window`);
    }
    const result = SCHEMA_MAP[method].safeParse(raw);
    if (!result.success) {
      throw new Error(`[ipc:${method}] payload validation failed — ${result.error.message}`);
    }
    return settle(fn, result.data);
  });
};

export const registerIpcHandlers = (handlers: IpcHandlers): void => {
  for (const method of INVOKE_METHODS) {
    handle(handlers, method);
  }
};
