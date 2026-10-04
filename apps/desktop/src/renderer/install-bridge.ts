// How the page reaches main: main serves this page itself (apps/cli/src/server/page-server.ts), so the page
// calls it and hears its events on its own origin, signed in by the cookie its handoff link set,
// whether it is the app's window, a browser under `pnpm dev:browser` or e2e's Chromium. Either way
// it is `globalThis.appBridge`, built from the one channel registry. Every reply is main's own, a
// value or the sentence it refused with. Main parses every payload (apps/cli/src/server/lib/ipc-handler.ts),
// so nothing is trusted here that was not before.

import { CHANNELS, isReply } from "@repo/contract/ipc-channels";
import type { WireValue } from "@repo/contract/ipc-channels";
import { jsonValueSchema } from "@repo/domain/json";
import type { JsonValue } from "@repo/domain/json";
import { EVENTS_PATH, INVOKE_PATH } from "@repo/contract/page-routes";

const invoke = async (method: string, payload: WireValue): Promise<JsonValue> => {
  const response = await fetch(INVOKE_PATH, {
    body: JSON.stringify({ method, payload }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return jsonValueSchema.parse(await response.json());
};

// one stream for every channel: a browser holds few connections to one origin
let stream: EventSource | null = null;
const events = (): EventSource => {
  stream ??= new EventSource(EVENTS_PATH);
  return stream;
};

const listen = (channel: string, listener: (data: JsonValue) => void): (() => void) => {
  const heard = (event: MessageEvent<string>): void => {
    listener(jsonValueSchema.parse(JSON.parse(event.data)));
  };
  events().addEventListener(channel, heard);
  return () => {
    events().removeEventListener(channel, heard);
  };
};

const ask = async (method: string, payload?: WireValue): Promise<WireValue> => {
  const reply = await invoke(method, payload);
  if (!isReply(reply)) {
    throw new Error(`main answered ${method} with something other than a reply`);
  }
  if (!reply.ok) {
    throw new Error(reply.message);
  }
  return reply.value;
};

/** Installs the bridge before the first render. */
export const installBridge = (): void => {
  // Untyped as it is built: the `appBridge` declaration in bridge.ts is where AppBridge is trusted.
  const entries = Object.entries(CHANNELS).map(([method, def]): [string, unknown] => {
    switch (def.kind) {
      case "invoke": {
        return [method, async (payload: WireValue) => await ask(method, payload)];
      }
      case "invoke-void": {
        return [method, async () => await ask(method)];
      }
      case "event": {
        return [method, (listener: (data: JsonValue) => void) => listen(def.channel, listener)];
      }
      default: {
        throw new Error("unknown IPC channel kind");
      }
    }
  });
  Reflect.set(globalThis, "appBridge", Object.fromEntries(entries));
};
