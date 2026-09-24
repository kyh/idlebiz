import { useCallback, useState } from "react";

interface Keyed<T> {
  key: string;
  value: T;
}

/** What a render under `key` holds: the stored value if it was stored under that key, else `initial`. */
export const keyedAt = <T>(stored: Keyed<T>, key: string, initial: T): Keyed<T> =>
  stored.key === key ? stored : { key, value: initial };

/**
 * State that starts over whenever `key` changes, without an effect: the value
 * is stored beside the key it belongs to, and a render under a new key stores
 * `initial` for it, so every change of key — back to an earlier one too —
 * reads as `initial` on its very first render. Setting the value it already
 * has is a no-op.
 */
export const useKeyedState = <T>(key: string, initial: T): [T, (v: T) => void] => {
  const [stored, setStored] = useState<Keyed<T>>({ key, value: initial });
  const set = useCallback(
    (v: T) =>
      setStored((prev) =>
        prev.key === key && Object.is(prev.value, v) ? prev : { key, value: v },
      ),
    [key],
  );
  const current = keyedAt(stored, key, initial);
  if (current !== stored) {
    setStored(current);
  }
  return [current.value, set];
};
