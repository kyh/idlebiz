import { ipcMain } from "electron";
import type { z } from "zod";
import { CHANNELS, type IpcMethod } from "@/shared/ipc-channels";
import { SCHEMAS, type IpcHandler } from "@/shared/ipc-registry";

// plain widening assignment (no cast): every schema value satisfies z.ZodType
const SCHEMA_MAP: Partial<Record<IpcMethod, z.ZodType>> = SCHEMAS;

function validate(method: IpcMethod, schema: z.ZodType, raw: unknown): unknown {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`[ipc:${method}] payload validation failed — ${result.error.message}`);
  }
  return result.data;
}

export function handle<M extends IpcMethod>(method: M, fn: IpcHandler<M>): void {
  const def = CHANNELS[method];
  const schema = SCHEMA_MAP[method];
  // boundary cast: the generic switch can't narrow fn per kind; the public
  // handle<M>() signature is what guarantees type-safety at call sites.
  const call = fn as (arg?: unknown) => unknown;

  switch (def.kind) {
    case "invoke":
      ipcMain.handle(def.channel, (_e, raw: unknown) =>
        call(schema ? validate(method, schema, raw) : raw),
      );
      return;
    case "invoke-void":
      ipcMain.handle(def.channel, () => call());
      return;
    case "event":
      throw new Error(`"${method}" is event-only; use broadcast()`);
  }
}
