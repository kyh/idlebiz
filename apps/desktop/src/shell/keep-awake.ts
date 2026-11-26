import { powerSaveBlocker } from "electron";

let blocker: number | null = null;

/**
 * Holds the Mac out of idle sleep while main asks (a run is in flight): an assertion that stops idle
 * sleep, never the display's sleep and never past a closed lid.
 */
export const keepAwake = (on: boolean) => {
  if (on && blocker === null) {
    blocker = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!on && blocker !== null) {
    powerSaveBlocker.stop(blocker);
    blocker = null;
  }
};
