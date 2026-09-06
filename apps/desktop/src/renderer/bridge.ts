import type { AppBridge } from "@/shared/ipc-registry";

/** The preload bridge. Absent only outside Electron, where nothing that calls this can work. */
export const bridge = (): AppBridge => {
  const b = window.appBridge;
  if (!b) throw new Error("appBridge unavailable");
  return b;
};
