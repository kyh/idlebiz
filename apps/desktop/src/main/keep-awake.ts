/** Something that holds the Mac awake until stopped: the shell's power assertion, or a test's fake. */
export interface PowerBlocker {
  start: () => number;
  stop: (id: number) => void;
}

/** Holds the Mac awake while `live`: at most one blocker, started once, stopped once. */
export interface KeepAwake {
  hold: (live: boolean) => void;
}

/**
 * The shell's assertion (a user-initiated activity) stops idle sleep and App Nap only: closing the
 * lid still sleeps the Mac, and a run in flight then waits for it to wake. Holding the display awake
 * would keep a screen lit that nobody is watching.
 */
export const keepAwake = (blocker: PowerBlocker): KeepAwake => {
  let held: number | null = null;
  return {
    hold: (live) => {
      if (live && held === null) {
        held = blocker.start();
      } else if (!live && held !== null) {
        blocker.stop(held);
        held = null;
      }
    },
  };
};
