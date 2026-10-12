import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { LoadReport, LoadSkip } from "@repo/domain/domain";
import { errorMessage } from "@repo/domain/errors";
import { parseJson } from "@repo/domain/json";
import { SaveFormatError } from "./company-codec";
import { parseDoc } from "./frontmatter";
import type { FrontmatterDoc } from "./frontmatter";

/** Oldest first; ties (same millisecond) by id, so boot order is stable. */
export const byAge = <T extends { createdAt: number; id: string }>(a: T, b: T): number =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id);

// Failed company loads must surface in the UI instead of presenting onboarding over a save.
let lastLoad: LoadReport = { skipped: [] };

export const loadReport = (): LoadReport => lastLoad;

export const resetLoadReport = (): void => {
  lastLoad = { skipped: [] };
};

export const skip = (kind: LoadSkip["kind"], file: string, cause: unknown): void => {
  lastLoad.skipped.push({
    error: errorMessage(cause),
    kind,
    newerBuild: cause instanceof SaveFormatError && cause.writtenBy === "newer",
    path: file,
  });
};

export const safeReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Whether `dir` holds any package, read or skipped: one boot skipped is the load report's to name, never replaced. */
export const holdsPackage = (dir: string, fileFor: (slug: string) => string): boolean =>
  safeReaddir(dir).some((slug) => existsSync(fileFor(slug)));

/** Report corrupt packages individually so one hand-edited file cannot prevent loading. */
export const loadPackages = <T extends { id: string }>(
  kind: LoadSkip["kind"],
  dir: string,
  fileFor: (slug: string) => string,
  decode: (doc: FrontmatterDoc) => T,
): T[] => {
  const rows: T[] = [];
  for (const slug of safeReaddir(dir)) {
    const file = fileFor(slug);
    if (!existsSync(file)) {
      continue;
    }
    try {
      const row = decode(parseDoc(readFileSync(file, "utf-8")));
      if (row.id !== slug) {
        throw new Error("package slug does not match its directory");
      }
      rows.push(row);
    } catch (error) {
      skip(kind, file, error);
    }
  }
  return rows;
};

/** Each `<id>.json` of `dir` that `schema` reads; one naming another id is skipped. */
export const loadRecords = <T extends { createdAt: number; id: string }>(
  kind: LoadSkip["kind"],
  dir: string,
  schema: z.ZodType<T>,
): T[] =>
  safeReaddir(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const file = path.join(dir, name);
      try {
        const record = schema.parse(parseJson(readFileSync(file, "utf-8")));
        if (`${record.id}.json` !== name) {
          throw new Error(`${kind} does not match its file's name`);
        }
        return [record];
      } catch (error) {
        skip(kind, file, error);
        return [];
      }
    })
    .toSorted(byAge);
