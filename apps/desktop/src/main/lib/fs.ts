import {
  appendFileSync,
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";
import { parseJson } from "@/shared/json";

// Every file main writes goes through here: atomically, and behind one gate.

// Reset gate: once suspended, no disk write may land — an in-flight run settling
// after ~/.idlebiz is deleted would otherwise resurrect files mid-teardown.
let writesSuspended = false;
export function suspendWrites(): void {
  writesSuspended = true;
}

/** Write the whole file via tmp + rename, so a reader never sees half of it. */
export function atomicWrite(path: string, content: string, options: { mode?: number } = {}): void {
  if (writesSuspended) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, options);
  // a tmp file left by a crash keeps its old mode through writeFileSync
  if (options.mode !== undefined) chmodSync(tmp, options.mode);
  renameSync(tmp, path);
}

/** Move a whole package (a directory) somewhere else under the save, behind the same gate. */
export function moveDir(from: string, to: string): void {
  if (writesSuspended) return;
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

/** Append one JSON row. Loss is acceptable: these are logs, not the save. */
export function appendJsonl<Row extends object>(path: string, row: Row): void {
  if (writesSuspended) return;
  try {
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  } catch {
    /* log loss is acceptable */
  }
}

/** A JSON file as `schema` sees it; null when missing, unparseable, or not that. */
export function readJsonFile<T>(path: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(parseJson(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** How much of a log to read for its last rows — a bound, so a long-lived log stays cheap to open. */
const TAIL_BYTES = 1024 * 1024;

/**
 * The last `limit` rows of a JSONL log that `schema` accepts. Reads only the
 * file's tail, dropping the partial first line, so the cost is bounded by
 * TAIL_BYTES rather than by how long the company has been playing.
 */
export function readJsonlTail<T>(path: string, schema: z.ZodType<T>, limit: number): T[] {
  let text: string;
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const rows: T[] = [];
  for (const line of text.split("\n").slice(-limit)) {
    if (line.trim() === "") continue;
    try {
      const parsed = schema.safeParse(parseJson(line));
      if (parsed.success) rows.push(parsed.data);
    } catch {
      /* skip a bad line */
    }
  }
  return rows;
}
