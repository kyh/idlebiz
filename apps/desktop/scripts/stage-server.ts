import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const cliRoot = path.join(repoRoot, "apps", "cli");

const PRUNED = [
  "README.md",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "node_modules/.pnpm",
  "node_modules/.bin",
];

const KEPT = new Set(["bin", "dist", "node_modules", "package.json", "resources"]);

/** Stages the built server into `dir`, and answers it. */
export const stageServer = async (dir: string) => {
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
