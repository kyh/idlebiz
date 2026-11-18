import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

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

const LAUNCH_OVERRIDES = new Set(["com.apple.FinderInfo", "com.apple.LaunchServices.OpenWith"]);

const redirectsLaunch = (real: string) => {
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

const realOf = (p: string) => {
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
export const judgeOpening = (roots: readonly string[], rel: string) => {
  for (const root of roots) {
    const base = realOf(root);
    const real = base === null ? null : realOf(path.resolve(base, rel === "" ? "." : rel));

    if (base !== null && real !== null && (real === base || real.startsWith(base + path.sep))) {
      const opens =
        (statSync(real).isDirectory()
          ? path.extname(real) === ""
          : READABLE.has(path.extname(real).toLowerCase())) && !redirectsLaunch(real);

      return { kind: opens ? "open" : "reveal", path: real } satisfies Opening | null;
    }
  }

  return null;
};

/**
 * What a click on a path an agent wrote may open. A path inside a root is taken as written. An
 * absolute one outside them names a root on another machine or in a copied save: it is
 * re-rooted from its workspace/ or shared/, under the root whose folder and parent it names
 * first, so a same-named file of another product never opens in its place.
 */
export const judgeAgentPath = (roots: readonly string[], token: string) => {
  const asWritten = judgeOpening(roots, token);
  const root = path.isAbsolute(token) ? /\/(?:workspace|shared)\//u.exec(token) : null;

  if (asWritten !== null || root === null) {
    return asWritten;
  }

  const named = token.slice(0, root.index + root[0].length);

  const names = (dir: string) =>
    named.endsWith(`/${path.basename(path.dirname(dir))}/${path.basename(dir)}/`);

  return judgeOpening(
    [...roots.filter(names), ...roots.filter((dir) => !names(dir))],
    token.slice(named.length),
  );
};
