/**
 * Snapshot undo/redo over one immutable value, as pure steps. An edit whose
 * updater hands back the same value records nothing and keeps the present, so
 * it renders nothing either.
 *
 * A gesture (a paint stroke, an ⌥drag) is one transaction: `begin` remembers
 * the present, its frames edit it with `live`, and `end` records one step only
 * if the gesture changed something. Undo and redo do nothing while a gesture
 * is open: its frames still to come would land on the reverted value outside
 * any step.
 */
export interface Timeline<T extends object> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
  /** The present as the open gesture found it; null between gestures. */
  readonly open: T | null;
}

/** A timeline with nothing behind or ahead of `present`. */
export const start = <T extends object>(present: T): Timeline<T> => ({
  future: [],
  open: null,
  past: [],
  present,
});

export const begin = <T extends object>(t: Timeline<T>): Timeline<T> =>
  t.open === null ? { ...t, open: t.present } : t;

/** Replace the present without recording: a gesture's frames, or a selection. */
export const live = <T extends object>(t: Timeline<T>, updater: (v: T) => T): Timeline<T> => {
  const present = updater(t.present);
  return present === t.present ? t : { ...t, present };
};

/** Close the gesture; `cap` bounds how many steps the past keeps. */
export const end = <T extends object>(t: Timeline<T>, cap: number): Timeline<T> => {
  if (t.open === null) {
    return t;
  }
  if (t.open === t.present) {
    return { ...t, open: null };
  }
  return { future: [], open: null, past: [...t.past, t.open].slice(-cap), present: t.present };
};

/** One undoable change; inside an open gesture it joins that gesture's step. */
export const commit = <T extends object>(
  t: Timeline<T>,
  updater: (v: T) => T,
  cap: number,
): Timeline<T> => (t.open === null ? end(live(begin(t), updater), cap) : live(t, updater));

export const undo = <T extends object>(t: Timeline<T>): Timeline<T> => {
  const prev = t.past.at(-1);
  if (t.open !== null || prev === undefined) {
    return t;
  }
  return { future: [...t.future, t.present], open: null, past: t.past.slice(0, -1), present: prev };
};

export const redo = <T extends object>(t: Timeline<T>): Timeline<T> => {
  const next = t.future.at(-1);
  if (t.open !== null || next === undefined) {
    return t;
  }
  return { future: t.future.slice(0, -1), open: null, past: [...t.past, t.present], present: next };
};
