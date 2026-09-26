import type { PowerSaveBlocker } from "electron";

/** What of Electron's `powerSaveBlocker` holding the Mac awake needs; tests hand in a fake. */
export type PowerBlocker = Pick<PowerSaveBlocker, "start" | "stop">;

/** Holds the Mac awake while `live`: at most one blocker, started once, stopped once. */
export interface KeepAwake {
  hold: (live: boolean) => void;
}

/**
 * `prevent-app-suspension` stops idle sleep and App Nap only: closing the lid still sleeps the
 * Mac, and a run in flight then waits for it to wake. Holding the display awake would keep a
 * screen lit that nobody is watching.
 */
export const keepAwake = (blocker: PowerBlocker): KeepAwake => {
  let held: number | null = null;
  return {
    hold: (live) => {
      if (live && held === null) {
        held = blocker.start("prevent-app-suspension");
      } else if (!live && held !== null) {
        blocker.stop(held);
        held = null;
      }
    },
  };
};
