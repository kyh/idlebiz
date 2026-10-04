import type { AppBridge } from "@repo/contract/ipc-registry";

declare global {
  // install-bridge.ts sets it on the window, which is the renderer's globalThis;
  // declared here rather than on Window so code under test in Node can name it.
  var appBridge: AppBridge | undefined;
}

/** The bridge to main. Absent only before main.tsx installs it, and in a test that set none. */
export const bridge = (): AppBridge => {
  const b = globalThis.appBridge;
  if (!b) {
    throw new Error("appBridge unavailable");
  }
  return b;
};
