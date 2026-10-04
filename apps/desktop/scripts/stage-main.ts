// Main as the .app ships it, a folder of its own that `bundle.resources` maps to
// Contents/Resources/main: main's bundle (`.output/main`, the package's `files`), and its production
// dependencies (the ACP adapters it runs, sharp) installed from the lockfile, the workspace's
// patches applied (codex-acp's external-sandbox patch among them), hoisted so no symlink rides into
// the bundle. `pnpm deploy` does exactly that; npm itself would ignore the lockfile and every patch.
// Main's bundle is lifted to the folder's root, beside its node_modules, so `index.js` resolves them
// as it does in the checkout.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

// what pnpm writes beside the package for a later install, and the links its bins get; nothing at
// runtime reads either, and a link in Resources is one more thing the signature has to explain
const PRUNED = ["pnpm-lock.yaml", "pnpm-workspace.yaml", "node_modules/.pnpm", "node_modules/.bin"];
// main's bundle and its dependencies: nothing else may reach the bundle
const KEPT = new Set(["assets", "index.js", "node_modules", "package.json"]);

/** Stages built main into `dir`, and answers it. */
export const stageMain = async (dir: string): Promise<string> => {
  if (!existsSync(path.join(packageRoot, ".output", "main", "index.js"))) {
    throw new Error("main is not built: run `pnpm --filter @repo/desktop build` first");
  }
  await rm(dir, { force: true, recursive: true });
  const deployed = spawnSync(
    "pnpm",
    ["--filter", "@repo/desktop", "deploy", "--prod", "--config.node-linker=hoisted", dir],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (deployed.status !== 0) {
    throw new Error(`pnpm deploy exited ${deployed.status ?? deployed.signal}`);
  }
  for (const entry of PRUNED) {
    await rm(path.join(dir, entry), { force: true, recursive: true });
  }
  const bundled = path.join(dir, ".output", "main");
  for (const name of await readdir(bundled)) {
    await rename(path.join(bundled, name), path.join(dir, name));
  }
  await rm(path.join(dir, ".output"), { force: true, recursive: true });
  const staged = await readdir(dir);
  const stray = staged.filter((name) => !KEPT.has(name));
  if (stray.length > 0) {
    throw new Error(`the staged main holds what its \`files\` never named: ${stray.join(", ")}`);
  }
  return dir;
};
