import { useCallback, useRef, useState } from "react";

export interface History<T> {
  present: T;
  /** Replace without recording — the frames inside a drag or a paint stroke. */
  live: (updater: (t: T) => T) => void;
  /** Record the present as an undo step; the `live` frames that follow belong to it. */
  mark: () => void;
  /** One undoable change; a no-op when the updater returns the same value. */
  commit: (updater: (t: T) => T) => void;
  undo: () => void;
  redo: () => void;
  /** Replace the present and forget the past — a document loaded from elsewhere. */
  reset: (next: T) => void;
}

/**
 * Snapshot undo/redo over one immutable value. The present is mirrored in a
 * ref so successive edits inside one event handler compose instead of each
 * reading the render's stale value.
 */
export function useHistory<T extends object>(init: () => T, cap = 100): History<T> {
  const [present, setPresent] = useState(init);
  const presentRef = useRef(present);
  const stack = useRef<{ past: T[]; future: T[] }>({ past: [], future: [] });

  const replace = useCallback((next: T) => {
    presentRef.current = next;
    setPresent(next);
  }, []);

  const live = useCallback(
    (updater: (t: T) => T) => replace(updater(presentRef.current)),
    [replace],
  );

  const mark = useCallback(() => {
    const s = stack.current;
    s.past.push(presentRef.current);
    if (s.past.length > cap) s.past.shift();
    s.future = [];
  }, [cap]);

  const commit = useCallback(
    (updater: (t: T) => T) => {
      const next = updater(presentRef.current);
      if (next === presentRef.current) return;
      mark();
      replace(next);
    },
    [mark, replace],
  );

  const undo = useCallback(() => {
    const s = stack.current;
    const prev = s.past.pop();
    if (prev === undefined) return;
    s.future.push(presentRef.current);
    replace(prev);
  }, [replace]);

  const redo = useCallback(() => {
    const s = stack.current;
    const next = s.future.pop();
    if (next === undefined) return;
    s.past.push(presentRef.current);
    replace(next);
  }, [replace]);

  const reset = useCallback(
    (next: T) => {
      stack.current = { past: [], future: [] };
      replace(next);
    },
    [replace],
  );

  return { present, live, mark, commit, undo, redo, reset };
}
