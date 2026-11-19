import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "..");
const built = path.resolve(packageRoot, "..", "desktop", "dist");
const staged = path.join(packageRoot, "dist", "page");

if (!existsSync(path.join(built, "index.html"))) {
  throw new Error("the page is not built: run `pnpm --filter @repo/desktop build` first");
}

await rm(staged, { force: true, recursive: true });

await cp(built, staged, { recursive: true });
