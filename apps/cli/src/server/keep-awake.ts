/** Holds the Mac awake while `live`, telling the shell only when that changes. */
export interface KeepAwake {
  hold: (live: boolean) => void;
}

/**
 * The shell's assertion (a user-initiated activity) stops idle sleep and App Nap only: closing the
 * lid still sleeps the Mac, and a run in flight then waits for it to wake. Holding the display awake
 * would keep a screen lit that nobody is watching.
 */
export const keepAwake = (tell: (on: boolean) => void): KeepAwake => {
  let held = false;
  return {
    hold: (live) => {
      if (live !== held) {
        held = live;
        tell(live);
      }
    },
  };
};
