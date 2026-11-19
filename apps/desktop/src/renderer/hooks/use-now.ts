import { useSyncExternalStore } from "react";

const TICK_MS = 30_000;

const subscribe = (onStoreChange: () => void) => {
  const id = window.setInterval(onStoreChange, TICK_MS);

  return (() => window.clearInterval(id)) satisfies () => void;
};

const getSnapshot = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;

export const useNow = () => useSyncExternalStore(subscribe, getSnapshot);
