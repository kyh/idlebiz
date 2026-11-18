import { z } from "zod";
import { errorMessage } from "@repo/domain/errors";
import { jsonValueSchema } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";

const VERSION = "2.0";
const METHOD_NOT_FOUND = -32_601;
const HANDLER_FAILED = -32_000;

const lineSchema = z.object({
  error: z.object({ code: z.number(), message: z.string() }).optional(),
  id: z.number().int().optional(),
  jsonrpc: z.literal(VERSION),
  method: z.string().optional(),
  params: jsonValueSchema.optional(),
  result: jsonValueSchema.optional(),
});

interface Message {
  readonly [key: string]: JsonValue;
}

export interface PeerOptions {
  write: (line: string) => void;
  stray: (line: string) => void;
  failed: (method: string, reason: string) => void;
}

export interface Peer<M extends string = string> {
  handle: <P>(
    method: M,
    schema: z.ZodType<P>,
    handler: (params: P) => JsonValue | Promise<JsonValue>,
  ) => void;
  on: <P>(method: M, schema: z.ZodType<P>, listener: (params: P) => void) => void;
  request: <R>(method: M, params: JsonValue, schema: z.ZodType<R>) => Promise<R>;
  notify: (method: M, params: JsonValue) => void;
  receive: (line: string) => void;
  close: (reason: string) => void;
}

interface Waiting {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
}

const parsedLine = (line: string) => {
  try {
    const parsed = lineSchema.safeParse(JSON.parse(line));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const createPeer = <M extends string = string>(options: PeerOptions) => {
  const handlers = new Map<string, (params: JsonValue | undefined) => Promise<JsonValue>>();
  const listeners = new Map<string, (params: JsonValue | undefined) => boolean>();
  const pending = new Map<number, Waiting>();
  let nextId = 0;
  let closed: string | null = null;

  const send = (message: Message) => {
    options.write(JSON.stringify({ jsonrpc: VERSION, ...message }));
  };

  const answer = async (id: number, method: string, params: JsonValue | undefined) => {
    const handler = handlers.get(method);

    if (handler === undefined) {
      send({ error: { code: METHOD_NOT_FOUND, message: `no method ${method}` }, id });

      return;
    }

    try {
      send({ id, result: await handler(params) });
    } catch (error) {
      send({ error: { code: HANDLER_FAILED, message: errorMessage(error) }, id });
    }
  };

  return {
    close(reason) {
      closed = reason;

      for (const waiting of pending.values()) {
        waiting.reject(new Error(reason));
      }

      pending.clear();
    },
    handle(method, schema, handler) {
      handlers.set(method, async (params) => await handler(schema.parse(params ?? null)));
    },
    notify(method, params) {
      if (closed === null) {
        send({ method, params });
      }
    },
    on(method, schema, listener) {
      listeners.set(method, (params) => {
        const parsed = schema.safeParse(params ?? null);

        if (parsed.success) {
          try {
            listener(parsed.data);
          } catch (error) {
            options.failed(method, errorMessage(error));
          }
        }

        return parsed.success;
      });
    },
    receive(line) {
      const message = parsedLine(line);

      if (message === null) {
        options.stray(line);

        return;
      }

      const { error, id, method, params, result } = message;

      if (method !== undefined) {
        if (id !== undefined) {
          void answer(id, method, params);
        } else if (listeners.get(method)?.(params) !== true) {
          options.stray(line);
        }

        return;
      }

      const waiting = id === undefined ? undefined : pending.get(id);

      if (id === undefined || waiting === undefined) {
        options.stray(line);

        return;
      }

      pending.delete(id);

      if (error !== undefined && result === undefined) {
        waiting.reject(new Error(error.message));
      } else if (error === undefined && result !== undefined) {
        waiting.resolve(result);
      } else {
        waiting.reject(
          new Error(`the answer to request ${String(id)} held neither one result nor one error`),
        );
      }
    },
    async request(method, params, schema) {
      if (closed !== null) {
        throw new Error(closed);
      }

      nextId += 1;
      const id = nextId;
      const { promise, reject, resolve } = Promise.withResolvers<JsonValue>();
      pending.set(id, { reject, resolve });
      send({ id, method, params });

      return schema.parse(await promise);
    },
  } satisfies Peer<M>;
};
