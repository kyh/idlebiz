import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { shell } from "electron";
import * as store from "@/main/store/store";

// Where a product is, as the team points at it: PRODUCT.md at the product's
// workspace root carries an `entry:` line naming a path there or a URL. Nothing
// in the app writes it; the agents' standing instructions ask them to.

/** What the product's PRODUCT.md `entry:` names, if the team wrote one. */
export function productEntry(productId: string): string | null {
  const { workspaceDir } = store.requireProduct(productId);
  try {
    const text = readFileSync(join(workspaceDir, "PRODUCT.md"), "utf8");
    const m = /^\s*`?entry`?\s*:\s*`?([^`\n]+?)`?\s*$/m.exec(text);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * What the OS may open outright from an agent-written workspace: folders and
 * things you read. Anything else — a .command, a binary, an installer — is
 * revealed in Finder instead, so a one-click execute can never be authored
 * into the team room.
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

/** `rel` resolved under `root`, or null when it would escape it. */
function inside(root: string, rel: string): string | null {
  const base = resolve(root);
  const target = resolve(base, rel === "" ? "." : rel);
  return target === base || target.startsWith(base + sep) ? target : null;
}

async function openTarget(target: string): Promise<void> {
  const opens =
    statSync(target, { throwIfNoEntry: false })?.isDirectory() ||
    READABLE.has(extname(target).toLowerCase());
  if (!opens) {
    shell.showItemInFolder(target);
    return;
  }
  const err = await shell.openPath(target);
  if (err) throw new Error(err);
}

/**
 * Open a workspace-relative path with the OS default app ("" is the company
 * workspace itself). Agents write paths relative to the workspace they ran in,
 * so the path is tried against the company's and every product's, and the
 * first that has it wins.
 */
export async function openWorkspacePath(companyId: string, rel: string): Promise<void> {
  const roots = [
    store.requireCompany(companyId).workspaceDir,
    ...store.listProducts(companyId).map((p) => p.workspaceDir),
  ];
  const targets = roots.map((root) => inside(root, rel)).filter((t): t is string => t !== null);
  const target = targets.find((t) => statSync(t, { throwIfNoEntry: false })) ?? targets[0];
  if (target === undefined) throw new Error("path escapes the workspace");
  await openTarget(target);
}

/** Open the product where it lives: a URL in the browser, a path in its workspace with its app. */
export async function openProduct(productId: string): Promise<string> {
  const product = store.requireProduct(productId);
  const entry = productEntry(productId) ?? "index.html";
  if (/^https?:\/\//.test(entry)) {
    await shell.openExternal(entry);
    return entry;
  }
  const target = inside(product.workspaceDir, entry);
  if (target === null) throw new Error("entry escapes the product's workspace");
  await openTarget(target);
  return entry;
}
