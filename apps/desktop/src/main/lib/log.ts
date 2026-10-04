import { report } from "@/main/lib/report";

/**
 * Main's console is its stderr, which the shell appends to the log file a report attaches
 * (`~/Library/Logs/IdleBiz/main.log`, or the dev root's `logs/`), so it is never the save root,
 * which a reset deletes. An error nothing caught is written there and main carries on: one failed
 * step must not take the office down with it.
 */
export const initLog = (): void => {
  process.on("uncaughtException", (error) => {
    report("uncaught", error);
  });
  process.on("unhandledRejection", (reason) => {
    report("unhandled rejection", reason);
  });
};
