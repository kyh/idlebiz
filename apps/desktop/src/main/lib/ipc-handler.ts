import { ipcMain } from "electron";
import type { z } from "zod";
import { CHANNELS, type IpcMethod, type WireValue } from "@/shared/ipc-channels";
import { SCHEMAS, type Contract, type IpcHandler } from "@/shared/ipc-registry";

// plain widening assignment (no cast): every schema's output is its method's payload
const SCHEMA_MAP: Partial<{ [M in IpcMethod]: z.ZodType<Contract[M]["payload"]> }> = SCHEMAS;

function validate<Payload>(method: IpcMethod, schema: z.ZodType<Payload>, raw: WireValue): Payload {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`[ipc:${method}] payload validation failed — ${result.error.message}`);
  }
  return result.data;
}

export function handle<M extends IpcMethod>(method: M, fn: IpcHandler<M>): void {
  const def = CHANNELS[method];
  const schema = SCHEMA_MAP[method];
  // SAFETY: the generic switch can't narrow fn per kind, but handle<M>()'s
  // public signature already pinned fn to this method's exact payload and
  // result types; this erased view only forgets that correlation.
  const call = fn as (
    arg?: Contract[M]["payload"],
  ) => Contract[M]["result"] | Promise<Contract[M]["result"]>;

  switch (def.kind) {
    case "invoke":
      if (schema === undefined) {
        throw new Error(`"${method}" is an invoke channel with no payload schema`);
      }
      ipcMain.handle(def.channel, (_e, raw: WireValue) => call(validate(method, schema, raw)));
      return;
    case "invoke-void":
      ipcMain.handle(def.channel, () => call());
      return;
    case "event":
      throw new Error(`"${method}" is event-only; use broadcast()`);
  }
}
