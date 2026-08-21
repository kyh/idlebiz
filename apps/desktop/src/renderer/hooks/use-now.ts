import { useSyncExternalStore } from "react";

const TICK_MS = 30_000;

// Module scope on purpose: useSyncExternalStore re-subscribes whenever the
// subscribe function's identity changes, so an inline arrow would tear down
// and restart the interval on every render — and the HUD re-renders on every
// activity event, which means the timer would never survive long enough to
// fire and `now` would stay frozen at its first value.
const subscribe = (onStoreChange: () => void): (() => void) => {
  const id = window.setInterval(onStoreChange, TICK_MS);
  return () => window.clearInterval(id);
};

const getSnapshot = (): number => Math.floor(Date.now() / TICK_MS) * TICK_MS;

/**
 * Wall-clock time as an external store. Reading `Date.now()` during render is
 * unstable — the value changes without a re-render, so anything derived from it
 * silently goes stale. The snapshot is quantised to the tick so React sees a
 * stable value between ticks.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
