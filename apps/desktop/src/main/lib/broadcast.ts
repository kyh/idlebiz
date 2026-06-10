import { BrowserWindow } from "electron";
import { CHANNELS, type IpcMethod } from "@/shared/ipc-channels";
import type { Contract } from "@/shared/ipc-registry";

type EventMethod = {
  [M in IpcMethod]: (typeof CHANNELS)[M]["kind"] extends "event" ? M : never;
}[IpcMethod];

export function broadcast<M extends EventMethod>(method: M, data: Contract[M]["result"]): void {
  const def = CHANNELS[method];
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(def.channel, data);
  }
}
