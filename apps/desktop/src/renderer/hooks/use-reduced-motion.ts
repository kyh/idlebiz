import { useSyncExternalStore } from "react";

// One MediaQueryList for the app, at module scope. An inline subscribe would
// re-attach its listener every render, and a getSnapshot that called
// matchMedia() would allocate a fresh list on each read — so the listener and
// the snapshot would be watching different objects. The typewriter re-renders
// every 16ms, which makes that churn constant rather than theoretical.
const query = window.matchMedia("(prefers-reduced-motion: reduce)");

const subscribe = (onStoreChange: () => void): (() => void) => {
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
};

const getSnapshot = (): boolean => query.matches;

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
