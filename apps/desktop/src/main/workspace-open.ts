import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * What the OS may open outright from an agent-written workspace: folders
 * without an extension and things you read, unless a symlink, a Finder alias,
 * the Finder bundle bit or a per-file OpenWith sends the click somewhere else.
 * Anything else — a .command, a binary, an installer — is revealed in Finder
 * instead, so a one-click execute can never be authored into the team room.
 */
const READABLE = new Set([
  ".md",
  ".txt",
  ".log",
  ".csv",
  ".json",
  ".yml",
  ".yaml",
  ".html",
  ".htm",
  ".css",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

// LaunchServices follows Finder aliases, launches folders with the bundle bit (both flagged in FinderInfo) and honours per-file OpenWith; realpath sees none of them.
const LAUNCH_OVERRIDES = new Set(["com.apple.FinderInfo", "com.apple.LaunchServices.OpenWith"]);

/** Whether LaunchServices may open `real` with something other than what its name says; true when unsure. */
const redirectsLaunch = (real: string): boolean => {
  try {
    const names = execFileSync("/usr/bin/xattr", [real], { encoding: "utf-8" }).split("\n");
    return names.some((name) => LAUNCH_OVERRIDES.has(name));
  } catch {
    return true;
  }
};

export interface Opening {
  kind: "open" | "reveal";
  path: string;
}

const realOf = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

/**
 * What a click on `rel` may do, judged on what the OS would really open: the
 * real path, since it follows symlinks the text never shows, and whether its
 * Finder flags or an OpenWith redirect it. Each root is tried in turn; null
 * when `rel` is missing under all of them or its real path leaves every one.
 */
export const judgeOpening = (roots: readonly string[], rel: string): Opening | null => {
  for (const root of roots) {
    const base = realOf(root);
    const real = base === null ? null : realOf(path.resolve(base, rel === "" ? "." : rel));
    if (base !== null && real !== null && (real === base || real.startsWith(base + path.sep))) {
      // A folder is a bundle the OS launches when it has a bundle extension (.app, .workflow…) or the FinderInfo bundle bit.
      const opens =
        (statSync(real).isDirectory()
          ? path.extname(real) === ""
          : READABLE.has(path.extname(real).toLowerCase())) && !redirectsLaunch(real);
      return { kind: opens ? "open" : "reveal", path: real };
    }
  }
  return null;
};
