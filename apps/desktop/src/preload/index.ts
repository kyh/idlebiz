import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "@/shared/ipc-channels";
// type-only: erased at build, so zod never enters the sandboxed preload bundle
import type { AppBridge } from "@/shared/ipc-registry";

function forwardEvent<T>(channel: string, listener: (data: T) => void): () => void {
  const wrapped = (_e: Electron.IpcRendererEvent, data: T) => listener(data);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const entries = Object.entries(CHANNELS).map(([method, def]) => {
  switch (def.kind) {
    case "invoke":
      return [method, (p: unknown) => ipcRenderer.invoke(def.channel, p)] as const;
    case "invoke-void":
      return [method, () => ipcRenderer.invoke(def.channel)] as const;
    case "event":
      return [method, (l: (e: unknown) => void) => forwardEvent(def.channel, l)] as const;
  }
});

const appBridge = Object.fromEntries(entries) as unknown as AppBridge;
contextBridge.exposeInMainWorld("appBridge", appBridge);
