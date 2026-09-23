import path from "node:path";
import { app, dialog } from "electron";
import log from "electron-log/main";
import { report } from "@/main/lib/report";

/**
 * Send main's console, its uncaught errors and any crashed renderer or child
 * process to a log file under the app's logs directory — never the save root,
 * which a reset deletes. The path is set here because electron-log's own macOS
 * default is `~/Library/Logs/<name>` whatever Electron's logs path says, which
 * would put dev runs in the packaged app's log. No `log.initialize()`: that
 * would add a preload to the sandboxed renderer.
 */
export const initLog = (): void => {
  if (!app.isPackaged) {
    app.setAppLogsPath(path.join(app.getPath("userData"), "logs"));
  }
  const logs = app.getPath("logs");
  log.transports.file.resolvePathFn = () => path.join(logs, log.transports.file.fileName);
  Object.assign(console, log.functions);
  log.errorHandler.startCatching({ showDialog: false });
  log.eventLogger.startLogging();
};

/** Boot threw: say where the log is and exit, so a broken launch never holds the single-instance lock. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value has no narrower honest type
export const bootFailed = (error: unknown): void => {
  report("boot", error);
  dialog.showErrorBox(
    "IdleBiz couldn't start",
    `What went wrong is written to ${log.transports.file.getFile().path}`,
  );
  app.exit(1);
};
