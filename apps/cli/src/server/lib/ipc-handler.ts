import type { z } from "zod";
import { refusePayload, settle } from "./ipc-reply";
import type { InvokeMethod } from "@repo/contract/ipc-channels";
import { SCHEMAS } from "@repo/contract/ipc-registry";
import type { Contract, IpcHandler } from "@repo/contract/ipc-registry";
import { parseJson } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";

const SCHEMA_MAP: { [M in InvokeMethod]: z.ZodType<Contract[M]["payload"]> } = SCHEMAS;

/** One handler per invoke method: a channel without one fails to compile. */
export type IpcHandlers = { [M in InvokeMethod]: IpcHandler<M> };

const isInvokeMethod = (method: string): method is InvokeMethod => Object.hasOwn(SCHEMAS, method);

// Generic so handlers[method] narrows to IpcHandler<M>; over the union it would not.
const call = async <M extends InvokeMethod>(
  handlers: Pick<IpcHandlers, M>,
  method: M,
  payload: JsonValue | undefined,
) => {
  const parsed = SCHEMA_MAP[method].safeParse(payload);
  return parsed.success
    ? await settle(handlers[method], parsed.data)
    : refusePayload(method, parsed.error);
};

export type IpcDispatch = (method: string, payload: JsonValue | undefined) => Promise<JsonValue>;

/**
 * Answers the window's invoke of `method` as main always has: the value, or the sentence a refusal
 * was worded in. Only the shell's own window reaches this, through the relay, so the payload is
 * parsed here and nowhere else; the reply crosses as JSON.
 */
export const ipcDispatcher =
  (handlers: IpcHandlers): IpcDispatch =>
  async (method, payload) => {
    const reply = isInvokeMethod(method)
      ? await call(handlers, method, payload)
      : { message: `[ipc] main answers no ${method}`, ok: false };
    return parseJson(JSON.stringify(reply));
  };
