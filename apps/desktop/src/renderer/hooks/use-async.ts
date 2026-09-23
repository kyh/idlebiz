import { useEffect, useState } from "react";
import type { DependencyList } from "react";
import { errorMessage } from "@/shared/errors";

/**
 * Where an async read stands. A ready value is `current` when it was read under
 * the deps of this render; after they change it stays on screen, not current,
 * until the new read lands.
 */
export type Loaded<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T; current: boolean }
  | { kind: "failed"; message: string };

type Settled<T> = { kind: "ready"; value: T } | { kind: "failed"; message: string };

interface Landed<T> {
  read: () => Promise<T>;
  settled: Settled<T>;
}

/** A read's outcome as a value: a rejection becomes a failure to show, never an unhandled rejection. */
export const settle = async <T>(read: () => Promise<T>): Promise<Landed<T>> => {
  try {
    return { read, settled: { kind: "ready", value: await read() } };
  } catch (error) {
    return { read, settled: { kind: "failed", message: errorMessage(error) } };
  }
};

/** What the last read to land means to a render whose deps give `read`. */
export const loadedOf = <T>(landed: Landed<T> | null, read: () => Promise<T>): Loaded<T> => {
  if (landed === null) {
    return { kind: "loading" };
  }
  if (landed.settled.kind === "failed") {
    return landed.settled;
  }
  return { ...landed.settled, current: landed.read === read };
};

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
 * An async read, re-run whenever `deps` change. A failure comes back as state,
 * as it does from useSubmission. A read that settles after its effect was
 * cleaned up — the deps changed, the component left — is dropped, so a slow
 * earlier fetch never overwrites a newer one.
 */
export const useAsync = <T>(read: () => Promise<T>, deps: DependencyList): Loaded<T> => {
  const [landed, setLanded] = useState<Landed<T> | null>(null);
  const readForDeps = useReadFor(read, deps);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      const outcome = await settle(readForDeps);
      if (alive) {
        setLanded(outcome);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [readForDeps]);
  return loadedOf(landed, readForDeps);
};
