import { useSyncExternalStore } from "react";

/**
 * Wall-clock time as an external store. Reading `Date.now()` during render is
 * unstable — the value changes without a re-render, so anything derived from it
 * silently goes stale. The snapshot is quantised to the tick so React sees a
 * stable value between ticks.
 */
export function useNow(tickMs = 30_000): number {
  return useSyncExternalStore(
    (onStoreChange) => {
      const id = window.setInterval(onStoreChange, tickMs);
      return () => window.clearInterval(id);
    },
    () => Math.floor(Date.now() / tickMs) * tickMs,
  );
}
