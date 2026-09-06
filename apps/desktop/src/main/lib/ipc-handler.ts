import { ipcMain } from "electron";
import type { z } from "zod";
import { CHANNELS, type InvokeMethod, type WireValue } from "@/shared/ipc-channels";
import { SCHEMAS, type Contract, type IpcHandler } from "@/shared/ipc-registry";

const SCHEMA_MAP: { [M in InvokeMethod]: z.ZodType<Contract[M]["payload"]> } = SCHEMAS;

export function handle<M extends InvokeMethod>(method: M, fn: IpcHandler<M>): void {
  ipcMain.handle(CHANNELS[method].channel, (_e, raw: WireValue) => {
    const result = SCHEMA_MAP[method].safeParse(raw);
    if (!result.success) {
      throw new Error(`[ipc:${method}] payload validation failed — ${result.error.message}`);
    }
    return fn(result.data);
  });
}
