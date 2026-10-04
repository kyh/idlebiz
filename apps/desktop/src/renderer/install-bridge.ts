// How the page reaches main: through whoever runs it. Under the desktop shell that is the shell's
// relay: one Tauri command, `main_invoke`, and main's events as Tauri events. In a browser it is
// the dev host's bridge on the page's own origin, whose token is in the page's URL fragment
// (`#bridge=…`). Either way it is `globalThis.appBridge`, built from the one channel registry.
// Every reply is main's own, a value or the sentence it refused with. Main parses every payload
// (src/main/lib/ipc-handler.ts), so nothing is trusted here that was not before.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEV_BRIDGE_PATH } from "@/shared/dev-bridge";
import { CHANNELS, isReply } from "@/shared/ipc-channels";
import type { WireValue } from "@/shared/ipc-channels";
import { jsonValueSchema } from "@/shared/json";
import type { JsonValue } from "@/shared/json";

interface Transport {
  invoke: (method: string, payload: WireValue) => Promise<JsonValue>;
  listen: (channel: string, listener: (data: JsonValue) => void) => () => void;
}

const tauriTransport: Transport = {
  invoke: async (method, payload) => await invoke<JsonValue>("main_invoke", { method, payload }),
  listen: (channel, listener) => {
    // Tauri registers a listener asynchronously, so an event can still arrive after the cleanup
    // ran and before the unlisten lands: the flag, cleared at once, keeps it from a stale listener
    let active = true;
    const listening = listen<JsonValue>(channel, (event) => {
      if (active) {
        listener(event.payload);
      }
    });
    const stop = async (): Promise<void> => {
      const unlisten = await listening;
      unlisten();
    };
    return () => {
      active = false;
      void stop();
    };
  },
};

const devHostTransport = (token: string): Transport => {
  // one stream for every channel: a browser holds few connections to one host
  let stream: EventSource | null = null;
  const events = (): EventSource => {
    stream ??= new EventSource(`${DEV_BRIDGE_PATH}/events?token=${encodeURIComponent(token)}`);
    return stream;
  };
  return {
    invoke: async (method, payload) => {
      const response = await fetch(`${DEV_BRIDGE_PATH}/invoke`, {
        body: JSON.stringify({ method, payload }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
      });
      return jsonValueSchema.parse(await response.json());
    },
    listen: (channel, listener) => {
      const heard = (event: MessageEvent<string>): void => {
        listener(jsonValueSchema.parse(JSON.parse(event.data)));
      };
      events().addEventListener(channel, heard);
      return () => {
        events().removeEventListener(channel, heard);
      };
    },
  };
};

const transport = (): Transport | null => {
  if (isTauri()) {
    return tauriTransport;
  }
  const token = new URLSearchParams(globalThis.location.hash.slice(1)).get("bridge");
  return token === null ? null : devHostTransport(token);
};

/** Installs the bridge before the first render; with no main to reach, `bridge()` says so. */
export const installBridge = (): void => {
  const through = transport();
  if (through === null) {
    return;
  }
  const ask = async (method: string, payload?: WireValue): Promise<WireValue> => {
    const reply = await through.invoke(method, payload);
    if (!isReply(reply)) {
      throw new Error(`main answered ${method} with something other than a reply`);
    }
    if (!reply.ok) {
      throw new Error(reply.message);
    }
    return reply.value;
  };
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
        return [
          method,
          (listener: (data: JsonValue) => void) => through.listen(def.channel, listener),
        ];
      }
      default: {
        throw new Error("unknown IPC channel kind");
      }
    }
  });
  Reflect.set(globalThis, "appBridge", Object.fromEntries(entries));
};
