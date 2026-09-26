import { app } from "electron";
import type { LaunchAtLogin } from "@/shared/domain";
import { RefusalError } from "@/shared/refusal";

// The OS login item is the only record: nothing in the save says whether IdleBiz opens at login.
// An unpackaged run would register node_modules' Electron.app, which is no IdleBiz at all.

export const launchAtLogin = (): LaunchAtLogin => {
  if (!app.isPackaged) {
    return "unavailable";
  }
  switch (app.getLoginItemSettings().status) {
    case "enabled": {
      return "on";
    }
    case "not-registered": {
      return "off";
    }
    case "requires-approval": {
      return "requires-approval";
    }
    case "not-found": {
      return "not-found";
    }
    // no default
  }
};

/** macOS may refuse without a word, so what it answers is read back rather than assumed. */
export const setLaunchAtLogin = (on: boolean): LaunchAtLogin => {
  if (!app.isPackaged) {
    throw new RefusalError("Only the installed app can open at login, not a dev build.");
  }
  app.setLoginItemSettings({ openAtLogin: on });
  return launchAtLogin();
};

/** A launch at login starts in the menu bar: the founder did not ask to see the office. */
export const openedAtLogin = (): boolean =>
  app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;
