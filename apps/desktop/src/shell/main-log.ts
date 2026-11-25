import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const MAIN_LOG_MAX_BYTES = 5 * 1024 * 1024;

const CUT = " [cut]\n";

/** `main.log`, in the logs folder (`logsDir`). */
export const mainLogPath = (logsDir: string) => path.join(logsDir, "main.log");

const capped = (text: string, maxBytes: number) => {
  const bytes = Buffer.from(text, "utf-8");

  if (bytes.length <= maxBytes) {
    return bytes;
  }

  let end = Math.max(0, maxBytes - CUT.length);

  // oxlint-disable-next-line no-bitwise -- a UTF-8 continuation byte is 0b10xxxxxx
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }

  return Buffer.concat([bytes.subarray(0, end), Buffer.from(CUT, "utf-8")]);
};

/**
 * What main prints and the shell's own lines, stamped, in one file a report attaches: a
 * Finder-launched app's stdout and stderr go nowhere. One backup past the cap, so the log costs at
 * most twice it, and a write that fails costs its line alone, said once per run of failures.
 */
export const createMainLog = (file: string, maxBytes = MAIN_LOG_MAX_BYTES) => {
  const backup = `${file}.1`;
  let size: number | null = null;
  let failing = false;

  const write = (bytes: Buffer) => {
    if (size === null) {
      mkdirSync(path.dirname(file), { recursive: true });
      size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    }

    if (size > 0 && size + bytes.length > maxBytes) {
      renameSync(file, backup);
      size = 0;
    }

    appendFileSync(file, bytes);
    size += bytes.length;
  };

  const append = (message: string) => {
    const stamp = new Date().toISOString();

    const text = message
      .split("\n")
      .map((line) => `${stamp} ${line}\n`)
      .join("");

    try {
      write(capped(text, maxBytes));
      failing = false;
    } catch (error) {
      size = null;

      if (!failing) {
        failing = true;
        console.error(`[shell] the log could not be written (${file}): ${String(error)}`);
      }
    }
  };

  return { append, failing: () => failing, path: file };
};

export type MainLog = ReturnType<typeof createMainLog>;
