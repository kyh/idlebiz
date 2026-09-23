import { useCallback, useRef, useState } from "react";
import * as timeline from "@/renderer/state/history";
import type { Timeline } from "@/renderer/state/history";

export interface History<T> {
  present: T;
  /** Replace without recording: the frames of a gesture, or a selection. */
  live: (updater: (t: T) => T) => void;
  /** Open a gesture: every edit until `end` is one undo step, and undo/redo do nothing meanwhile. */
  begin: () => void;
  /** Close the gesture, recording it only if it changed the present. */
  end: () => void;
  /** One undoable change; inside an open gesture it joins that gesture's step. */
  commit: (updater: (t: T) => T) => void;
  undo: () => void;
  redo: () => void;
}

/**
 * Undo/redo over one immutable value, on the pure timeline in `state/history.ts`.
 * The timeline lives in a ref so successive edits inside one event handler
 * compose instead of each reading the render's stale value; state holds only
 * its present, so only a new present renders.
 */
export const useHistory = <T extends object>(init: () => T, cap = 100): History<T> => {
  const [present, setPresent] = useState(init);
  const timelineRef = useRef(timeline.start(present));

  const apply = useCallback((step: (t: Timeline<T>) => Timeline<T>) => {
    timelineRef.current = step(timelineRef.current);
    setPresent(timelineRef.current.present);
  }, []);

  const live = useCallback(
    (updater: (t: T) => T) => apply((t) => timeline.live(t, updater)),
    [apply],
  );
  const begin = useCallback(() => apply(timeline.begin), [apply]);
  const end = useCallback(() => apply((t) => timeline.end(t, cap)), [apply, cap]);
  const commit = useCallback(
    (updater: (t: T) => T) => apply((t) => timeline.commit(t, updater, cap)),
    [apply, cap],
  );
  const undo = useCallback(() => apply(timeline.undo), [apply]);
  const redo = useCallback(() => apply(timeline.redo), [apply]);

  return { begin, commit, end, live, present, redo, undo };
};
