// The server as the .app ships it, a folder of its own that `bundle.resources` maps to
// Contents/Resources/server: the `idlebiz` package as its `files` name it (the bundle and the page
// staged beside it in `dist/`, the skills and the employee sheets in `resources/`, the bin), and its
// production dependencies (the ACP adapters it runs, sharp) installed from the lockfile, the
// workspace's patches applied (codex-acp's external-sandbox patch among them), hoisted so no symlink
// rides into the bundle. `pnpm deploy` does exactly that; npm itself would ignore the lockfile and
// every patch. As kyh/inteligir stages its CLI.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const cliRoot = path.join(repoRoot, "apps", "cli");

// what pnpm writes beside the package for a later install, the links its bins get, and the README
// its packlist takes whatever `files` says; nothing at runtime reads any of them, and a link in
// Resources is one more thing the signature has to explain
const PRUNED = [
  "README.md",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "node_modules/.pnpm",
  "node_modules/.bin",
];
// the package's `files` and its dependencies: nothing else may reach the bundle
const KEPT = new Set(["bin", "dist", "node_modules", "package.json", "resources"]);

/** Stages the built server into `dir`, and answers it. */
export const stageServer = async (dir: string): Promise<string> => {
  for (const built of ["dist/index.js", "dist/page/index.html"]) {
    if (!existsSync(path.join(cliRoot, built))) {
      throw new Error(
        `the server is not built (${built}): run \`pnpm --filter idlebiz build\` first`,
      );
    }
  }
  await rm(dir, { force: true, recursive: true });
  const deployed = spawnSync(
    "pnpm",
    ["--filter", "idlebiz", "deploy", "--prod", "--config.node-linker=hoisted", dir],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (deployed.status !== 0) {
    throw new Error(`pnpm deploy exited ${deployed.status ?? deployed.signal}`);
  }
  for (const entry of PRUNED) {
    await rm(path.join(dir, entry), { force: true, recursive: true });
  }
  const staged = await readdir(dir);
  const stray = staged.filter((name) => !KEPT.has(name));
  if (stray.length > 0) {
    throw new Error(`the staged server holds what its \`files\` never named: ${stray.join(", ")}`);
  }
  return dir;
};
