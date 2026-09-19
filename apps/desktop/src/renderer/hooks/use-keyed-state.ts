import { useCallback, useState } from "react";

/**
 * State that starts over whenever `key` changes, without an effect: the value
 * is stored beside the key it belongs to, so a new key reads as `initial` on
 * the very first render. Setting the value it already has is a no-op.
 */
export const useKeyedState = <K, T>(key: K, initial: T): [T, (v: T) => void] => {
  const [s, setS] = useState({ key, value: initial });
  const value = Object.is(s.key, key) ? s.value : initial;
  const set = useCallback(
    (v: T) =>
      setS((prev) =>
        Object.is(prev.key, key) && Object.is(prev.value, v) ? prev : { key, value: v },
      ),
    [key],
  );
  return [value, set];
};
