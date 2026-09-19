import { useEffect, useState } from "react";
import type { DependencyList } from "react";

const sameDeps = (a: DependencyList, b: DependencyList): boolean =>
  a.length === b.length && a.every((dep, i) => Object.is(dep, b[i]));

/**
 * `read` as of the last render where `deps` changed — one identity per set of deps,
 * compared the way useEffect compares them, so an effect can key on it alone.
 */
const useReadFor = <T>(read: () => Promise<T>, deps: DependencyList): (() => Promise<T>) => {
  const [tracked, setTracked] = useState({ deps, read });
  if (sameDeps(tracked.deps, deps)) {
    return tracked.read;
  }
  setTracked({ deps, read });
  return read;
};

/**
 * The value of an async read, null until it lands. A read that resolves after
 * its effect was cleaned up — the deps changed, the component left — is dropped,
 * so a slow earlier fetch never overwrites a newer one.
 */
export const useAsync = <T>(read: () => Promise<T>, deps: DependencyList): T | null => {
  const [value, setValue] = useState<T | null>(null);
  const readForDeps = useReadFor(read, deps);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      const v = await readForDeps();
      if (alive) {
        setValue(v);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [readForDeps]);
  return value;
};
