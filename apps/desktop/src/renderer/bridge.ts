import type { AppBridge } from "@/shared/ipc-registry";

declare global {
  // install-bridge.ts sets it on the window, which is the renderer's globalThis;
  // declared here rather than on Window so code under test in Node can name it.
  var appBridge: AppBridge | undefined;
}

/** The bridge to main. Absent only with no main to reach, where nothing that calls this can work. */
export const bridge = (): AppBridge => {
  const b = globalThis.appBridge;
  if (!b) {
    throw new Error("appBridge unavailable");
  }
  return b;
};
