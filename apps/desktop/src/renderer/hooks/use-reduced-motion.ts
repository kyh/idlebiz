import { useSyncExternalStore } from "react";

const query = window.matchMedia("(prefers-reduced-motion: reduce)");

const subscribe = (onStoreChange: () => void) => {
  query.addEventListener("change", onStoreChange);

  return (() => query.removeEventListener("change", onStoreChange)) satisfies () => void;
};

const getSnapshot = () => query.matches;

export const useReducedMotion = () => useSyncExternalStore(subscribe, getSnapshot);
