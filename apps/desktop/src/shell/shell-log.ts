import type { MainLog } from "./main-log";

let file: MainLog | null = null;

/** From now on the shell's lines go to main's log too. A launch starts one main, so one log. */
export const writeShellLogTo = (log: MainLog) => {
  file = log;
};

/**
 * One of the shell's own lines, on stderr for a terminal launch and in main's log once it is open,
 * every line tagged, since an untagged one there reads as main's own.
 */
export const shellLog = (message: string) => {
  const line = `[shell] ${message.replaceAll("\n", "\n[shell] ")}`;
  console.error(line);
  file?.append(line);
};
