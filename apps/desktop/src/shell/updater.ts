import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { app, autoUpdater as squirrel, dialog } from "electron";
import electronUpdater from "electron-updater";
import { heldMain, markQuitting, takeMain } from "./shell";
import { shellLog } from "./shell-log";

const { autoUpdater } = electronUpdater;

let installing = false;

const feedNamed = () => existsSync(path.join(process.resourcesPath, "app-update.yml"));

const updater = () => {
  if (!app.isPackaged) {
    throw new Error("only the installed app updates itself");
  }

  if (!feedNamed()) {
    throw new Error("this build was packed with no release feed, so it takes no updates");
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  return autoUpdater;
};

const newest = async () => {
  const checked = await updater().checkForUpdates();

  return checked?.isUpdateAvailable === true ? checked.updateInfo.version : null;
};

/** The newest release, when the feed offers one newer than this build. */
export const checkUpdate = async () => {
  const version = await newest();

  return version === null ? null : { version };
};

const failed = async (version: string, reason: string) => {
  shellLog(`could not install IdleBiz ${version}: ${reason}`);
  await dialog.showMessageBox({
    message: "IdleBiz couldn't update",
    detail: `IdleBiz ${version} was downloaded but would not install: ${reason}\n\nIdleBiz opens again on the version it has.`,
    title: "IdleBiz",
    type: "error",
  });
  app.relaunch();
  app.exit(0);
};

/**
 * Downloads `version`, which Squirrel takes only when it is signed by the same Developer ID as this
 * copy and matches the SHA-512 the feed names; then stops main as a quit does, since the update
 * replaces the server main loads and the launcher the runs call, and installs it and starts the app
 * again. A failed download ends with main still running.
 */
export const installUpdate = async (version: string) => {
  if (installing) {
    throw new Error("IdleBiz is already updating");
  }

  installing = true;

  try {
    const offered = await newest();

    if (offered === null) {
      throw new Error("no newer IdleBiz is offered any more");
    }

    if (offered !== version) {
      throw new Error(`IdleBiz ${offered} has replaced ${version} as the newest`);
    }

    await Promise.all([autoUpdater.downloadUpdate(), once(squirrel, "update-downloaded")]);
  } catch (error) {
    installing = false;
    throw error;
  }

  void (async () => {
    await heldMain()?.stop();
    takeMain();
    markQuitting();
    autoUpdater.once("error", (error) => {
      void failed(version, String(error));
    });

    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      await failed(version, String(error));
    }
  })();
};
