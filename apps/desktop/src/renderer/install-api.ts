// The page's API as main.tsx installs it: an oRPC client over the server's RPC route, and one
// server-sent stream for its events. Apart from api.ts, which code under test in node reads, since
// this one needs the browser's EventSource and location.

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { EVENTS_PATH, RPC_PREFIX } from "@repo/contract/routes";
import { jsonValueSchema } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";
import type { Api } from "@/renderer/api";

/** Installs the API before the first render. */
export const installApi = (): void => {
  // no headers: the page holds no bearer, in the window as in a tab; its cookie rides along
  const link = new RPCLink({ origin: globalThis.location.origin, url: RPC_PREFIX });
  // one stream for every event: a browser holds few connections to one origin
  let stream: EventSource | null = null;
  const events = (): EventSource => {
    stream ??= new EventSource(EVENTS_PATH);
    return stream;
  };
  // untyped as it is built: an event carries what the contract names for it, and the `appApi`
  // declaration above is where that is trusted, as the server is
  const listenToStream = (event: string, listener: (data: JsonValue) => void): (() => void) => {
    const heard = (message: MessageEvent<string>): void => {
      listener(jsonValueSchema.parse(JSON.parse(message.data)));
    };
    events().addEventListener(event, heard);
    return () => {
      events().removeEventListener(event, heard);
    };
  };
  const client: Api = createORPCClient(link);
  Reflect.set(globalThis, "appApi", { api: client, listen: listenToStream });
};
