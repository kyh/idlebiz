import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Company, Employee } from "@repo/domain/domain";
import { report } from "../lib/report";
import { toolCacheDir } from "../paths";

const execFileAsync = promisify(execFile);

/** One temp folder the runs share, outside their working trees: see toolCacheEnv(). */
export const runTmpdir = (): string => path.join(toolCacheDir(), "tmp");

// One cache the runs share, outside their working trees and apart from the founder's: a package
// a run installs never lands in a store the founder's own projects link from. A run writes only
// its own folders, so every cache a toolchain would keep in HOME is moved here, and updaters that
// would rewrite a CLI the founder runs are off. TMPDIR is moved too: a run connects only to
// sockets in its own folders, and the founder's TMPDIR is full of theirs.
export const toolCacheEnv = () => ({
  BUN_INSTALL_CACHE_DIR: path.join(toolCacheDir(), "bun"),
  COREPACK_HOME: path.join(toolCacheDir(), "corepack"),
  DISABLE_AUTOUPDATER: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  PLAYWRIGHT_BROWSERS_PATH: path.join(toolCacheDir(), "ms-playwright"),
  TMPDIR: runTmpdir(),
  XDG_CACHE_HOME: toolCacheDir(),
  npm_config_cache: path.join(toolCacheDir(), "npm"),
  npm_config_devdir: path.join(toolCacheDir(), "node-gyp"),
  npm_config_update_notifier: "false",
  pnpm_config_store_dir: path.join(toolCacheDir(), "pnpm-store"),
});

/**
 * A product's workspace as a repository, made by main when it is none yet: a run cannot write a
 * repository's config or hooks, which the founder's own git would run. macOS's git, whose `init`
 * runs nothing the folder holds. Without Apple's command line tools it has no git to run, and the
 * run goes on in a plain folder rather than fail every attempt.
 */
export const ensureRepository = async (workspace: string): Promise<void> => {
  const stats = await lstat(path.join(workspace, ".git")).catch(() => null);
  if (stats === null) {
    try {
      await execFileAsync("/usr/bin/git", ["init", "--quiet"], { cwd: workspace });
    } catch (error) {
      report("repository", error);
    }
  }
};

/**
 * Who a run's commits name, since it cannot write git's config to say so. Nor do they sign:
 * the founder's global config may sign every commit and tag with keys the seal hides, which
 * would fail each one.
 */
export const gitIdentity = (emp: Employee, company: Company) => {
  const email = `${emp.id}@${company.id}.idlebiz.invalid`;
  return {
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_NAME: emp.name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_NAME: emp.name,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "commit.gpgSign",
    GIT_CONFIG_KEY_1: "tag.gpgSign",
    GIT_CONFIG_KEY_2: "tag.forceSignAnnotated",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_VALUE_2: "false",
  };
};
