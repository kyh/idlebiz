import { useEffect, useState, type DependencyList } from "react";

/**
 * The value of an async read, null until it lands. A read that resolves after
 * its effect was cleaned up — the deps changed, the component left — is dropped,
 * so a slow earlier fetch never overwrites a newer one.
 */
export function useAsync<T>(read: () => Promise<T>, deps: DependencyList): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    void read().then((v) => {
      if (alive) setValue(v);
      return null;
    });
    return () => {
      alive = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the caller names what the read depends on
  }, deps);
  return value;
}
