import { ipcMain } from "electron";
import type { z } from "zod";
import { CHANNELS } from "@/shared/ipc-channels";
import type { InvokeMethod, WireValue } from "@/shared/ipc-channels";
import { SCHEMAS } from "@/shared/ipc-registry";
import type { Contract, IpcHandler } from "@/shared/ipc-registry";

const SCHEMA_MAP: { [M in InvokeMethod]: z.ZodType<Contract[M]["payload"]> } = SCHEMAS;

export const handle = <M extends InvokeMethod>(method: M, fn: IpcHandler<M>): void => {
  ipcMain.handle(CHANNELS[method].channel, (_e, raw: WireValue) => {
    const result = SCHEMA_MAP[method].safeParse(raw);
    if (!result.success) {
      throw new Error(`[ipc:${method}] payload validation failed — ${result.error.message}`);
    }
    return fn(result.data);
  });
};
