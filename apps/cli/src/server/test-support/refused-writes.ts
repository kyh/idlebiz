import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpFileOf } from "../lib/fs";

/**
 * Makes each write of `file` fail until the returned undo, as a save that refuses it does, for
 * every user: a directory stands where `atomicWrite` stages the file, which it cannot remove.
 * A file mode would not do, since root writes through one. Reads of `file` still succeed.
 */
export const refuseWritesTo = (file: string) => {
  const blocker = tmpFileOf(file);
  mkdirSync(blocker, { recursive: true });

  return () => {
    rmSync(blocker, { force: true, recursive: true });
  };
};

/**
 * Makes each write under `dir`, which does not exist yet, fail until the returned undo, for every
 * user: a file stands where the directory would be made, so nothing can be made under it.
 */
export const refuseWritesUnder = (dir: string) => {
  writeFileSync(dir, "", { flag: "wx" });

  return () => {
    rmSync(dir, { force: true });
  };
};
