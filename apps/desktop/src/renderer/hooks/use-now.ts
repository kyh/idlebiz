import { useSyncExternalStore } from "react";

const TICK_MS = 30_000;

// Stable subscription identity keeps frequent HUD updates from restarting the timer.
const subscribe = (onStoreChange: () => void): (() => void) => {
  const id = window.setInterval(onStoreChange, TICK_MS);
  return () => window.clearInterval(id);
};

const getSnapshot = (): number => Math.floor(Date.now() / TICK_MS) * TICK_MS;

// Quantized snapshots stay stable between ticks, as useSyncExternalStore requires.
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
