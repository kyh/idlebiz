import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { errorMessage } from "@/shared/errors";
import { parseJson } from "@/shared/json";

// Every file main writes goes through here: atomically, and behind one gate.

// Reset gate: once suspended, no disk write may land — an in-flight run settling
// after ~/.idlebiz is deleted would otherwise resurrect files mid-teardown.
let writesSuspended = false;
export const suspendWrites = (): void => {
  writesSuspended = true;
};

/**
 * Write the whole file via tmp + rename, so a reader never sees half of it. The tmp is always
 * made new: one already there, left by a crash or planted as a link to where a reader waits,
 * is removed, and `wx` (O_EXCL) never opens through a link, not even a dangling one.
 */
export const atomicWrite = (
  file: string,
  content: string,
  options: { mode?: number } = {},
): void => {
  if (writesSuspended) {
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, content, { flag: "wx", mode: options.mode });
  renameSync(tmp, file);
};

/** Move a whole package (a directory) somewhere else under the save, behind the same gate. */
export const moveDir = (from: string, to: string): void => {
  if (writesSuspended) {
    return;
  }
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
};

/** Append one JSON row. Loss is acceptable: these are logs, not the save. */
// oxlint-disable-next-line anti-slop/no-object-parameters -- a sink, not an input: any row JSON.stringify can write
export const appendJsonl = (file: string, row: object): void => {
  if (writesSuspended) {
    return;
  }
  try {
    appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch {
    /* log loss is acceptable */
  }
};

/** A JSON file as `schema` sees it; null when missing, unparseable, or not that. */
export const readJsonFile = <T>(file: string, schema: z.ZodType<T>): T | null => {
  try {
    const parsed = schema.safeParse(parseJson(readFileSync(file, "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * A JSON file about to be rewritten: null only when it does not exist yet.
 * Anything else unreadable throws, so a read-modify-write never replaces a
 * file it could not read.
 */
export const readJsonFileForUpdate = <T>(file: string, schema: z.ZodType<T>): T | null => {
  if (!existsSync(file)) {
    return null;
  }
  let cause: string;
  try {
    const parsed = schema.safeParse(parseJson(readFileSync(file, "utf-8")));
    if (parsed.success) {
      return parsed.data;
    }
    cause = z.prettifyError(parsed.error);
  } catch (error) {
    cause = errorMessage(error);
  }
  throw new Error(
    `IdleBiz can't read ${file} (${cause}). Fix it by hand; it will not be overwritten.`,
  );
};

/** How much of a log to read for its last rows — a bound, so a long-lived log stays cheap to open. */
const TAIL_BYTES = 1024 * 1024;

/**
 * The last `limit` rows of a JSONL log that `schema` accepts. Reads only the
 * file's tail, dropping the partial first line, so the cost is bounded by
 * TAIL_BYTES rather than by how long the company has been playing.
 */
export const readJsonlTail = <T>(file: string, schema: z.ZodType<T>, limit: number): T[] => {
  if (limit <= 0) {
    return [];
  }
  let text: string;
  try {
    const fd = openSync(file, "r");
    try {
      const { size } = fstatSync(fd);
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf-8");
      if (start > 0) {
        text = text.slice(text.indexOf("\n") + 1);
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const rows: T[] = [];
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  for (const line of lines.slice(-limit)) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const parsed = schema.safeParse(parseJson(line));
      if (parsed.success) {
        rows.push(parsed.data);
      }
    } catch {
      /* skip a bad line */
    }
  }
  return rows;
};
