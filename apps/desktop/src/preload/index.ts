import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, isReply } from "@/shared/ipc-channels";
import type { IpcMethod, WireValue } from "@/shared/ipc-channels";
// type-only: erased at build, so zod never enters the sandboxed preload bundle
import type { Contract } from "@/shared/ipc-registry";

const invoke = async (
  channel: string,
  payload?: Contract[IpcMethod]["payload"],
): Promise<WireValue> => {
  const reply: unknown = await ipcRenderer.invoke(channel, payload);
  if (!isReply(reply)) {
    throw new Error(`main answered ${channel} with something other than a reply`);
  }
  if (!reply.ok) {
    throw new Error(reply.message);
  }
  return reply.value;
};

const forwardEvent = (channel: string, listener: (data: WireValue) => void): (() => void) => {
  const wrapped = (_e: Electron.IpcRendererEvent, data: WireValue) => listener(data);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
};

// Untyped as it crosses: the renderer's `appBridge` declaration is where AppBridge is trusted.
const entries = Object.entries(CHANNELS).map(([method, def]): [string, unknown] => {
  switch (def.kind) {
    case "invoke": {
      return [method, (p: Contract[IpcMethod]["payload"]) => invoke(def.channel, p)];
    }
    case "invoke-void": {
      return [method, () => invoke(def.channel)];
    }
    case "event": {
      return [method, (l: (e: WireValue) => void) => forwardEvent(def.channel, l)];
    }
    default: {
      throw new Error("unknown IPC channel kind");
    }
  }
});

contextBridge.exposeInMainWorld("appBridge", Object.fromEntries(entries));
