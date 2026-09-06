import { useSyncExternalStore } from "react";

// The subscription and snapshot share one MediaQueryList.
const query = window.matchMedia("(prefers-reduced-motion: reduce)");

const subscribe = (onStoreChange: () => void): (() => void) => {
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
};

const getSnapshot = (): boolean => query.matches;

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
