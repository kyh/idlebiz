import { ipcMain } from "electron";
import type { WebFrameMain } from "electron";
import type { z } from "zod";
import { settle } from "@/main/lib/ipc-reply";
import { CHANNELS } from "@/shared/ipc-channels";
import type { InvokeMethod, WireValue } from "@/shared/ipc-channels";
import { SCHEMAS } from "@/shared/ipc-registry";
import type { Contract, IpcHandler } from "@/shared/ipc-registry";

const SCHEMA_MAP: { [M in InvokeMethod]: z.ZodType<Contract[M]["payload"]> } = SCHEMAS;

/** Only the app's own window may call main: its top frame, never a frame something embedded. */
const fromOurWindow = (frame: WebFrameMain | null): boolean =>
  frame !== null && frame.parent === null;

export const handle = <M extends InvokeMethod>(method: M, fn: IpcHandler<M>): void => {
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
