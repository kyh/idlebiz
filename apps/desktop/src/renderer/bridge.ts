import type { AppBridge } from "@/shared/ipc-registry";

declare global {
  // The preload exposes it on the window, which is the renderer's globalThis;
  // declared here rather than on Window so code under test in Node can name it.
  var appBridge: AppBridge | undefined;
}

/** The preload bridge. Absent only outside Electron, where nothing that calls this can work. */
export const bridge = (): AppBridge => {
  const b = globalThis.appBridge;
  if (!b) {
    throw new Error("appBridge unavailable");
  }
  return b;
};
