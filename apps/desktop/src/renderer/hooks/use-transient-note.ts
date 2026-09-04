import { useCallback, useEffect, useRef, useState } from "react";

/** A message that shows itself for `ms` and then clears — "Sent ✓", "Copied". */
export function useTransientNote(ms: number): [string | null, (message: string) => void] {
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const show = useCallback(
    (message: string) => {
      setNote(message);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setNote(null);
      }, ms);
    },
    [ms],
  );

  return [note, show];
}
