import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type IpcMethod } from "@/shared/ipc-channels";
// type-only: erased at build, so zod never enters the sandboxed preload bundle
import type { AppBridge, Contract } from "@/shared/ipc-registry";

type BridgeMethod = AppBridge[IpcMethod];

function forwardEvent<T>(channel: string, listener: (data: T) => void): () => void {
  const wrapped = (_e: Electron.IpcRendererEvent, data: T) => listener(data);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const entries = Object.entries(CHANNELS).map(([method, def]): [string, BridgeMethod] => {
  switch (def.kind) {
    case "invoke":
      return [method, (p: Contract[IpcMethod]["payload"]) => ipcRenderer.invoke(def.channel, p)];
    case "invoke-void":
      return [method, () => ipcRenderer.invoke(def.channel)];
    case "event":
      // `never` is the contravariant-position stand-in that keeps this
      // listener assignable to every per-method event signature.
      return [method, (l: (e: never) => void) => forwardEvent(def.channel, l)];
  }
});

contextBridge.exposeInMainWorld("appBridge", Object.fromEntries(entries));
