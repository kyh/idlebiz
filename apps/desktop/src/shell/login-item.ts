import { app } from "electron";
import type { LaunchAtLogin } from "@repo/domain/domain";
import { shellLog } from "./shell-log";

type Status = Electron.LoginItemSettings["status"];

const launchAtLoginOf = (status: Status) => {
  const of: Record<Status, LaunchAtLogin> = {
    enabled: "on",
    "not-found": "not-found",
    "not-registered": "off",
    "requires-approval": "requires-approval",
  };

  return of[status];
};

const SERVICE = { type: "mainAppService" } as const;

const available = () => app.isPackaged && process.platform === "darwin";

/** Open at login as macOS keeps it, read back after every change. */
export const loginItemStatus = () => {
  const status: LaunchAtLogin = available()
    ? launchAtLoginOf(app.getLoginItemSettings(SERVICE).status)
    : "unavailable";

  return status;
};

export const setLoginItem = (on: boolean) => {
  if (available()) {
    try {
      app.setLoginItemSettings({ ...SERVICE, openAtLogin: on });
    } catch (error) {
      shellLog(`macOS refused the login item: ${String(error)}`);
    }
  }

  return loginItemStatus();
};

/** Whether this launch is the login item's: the launch Apple event says so. */
export const launchedAtLogin = () =>
  available() && app.getLoginItemSettings(SERVICE).wasOpenedAtLogin;
