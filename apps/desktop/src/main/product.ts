import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { shell } from "electron";
import * as store from "@/main/store/store";

// The product is whatever the team points at: PRODUCT.md in the workspace
// carries an `entry:` line naming a path in the workspace or a URL. Nothing in
// the app writes it; the agents' standing instructions ask them to.

/** What PRODUCT.md's `entry:` names, if the team wrote one. */
export function productEntry(companyId: string): string | null {
  const { workspaceDir } = store.requireCompany(companyId);
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

/** Open a workspace-relative path with the OS default app ("" is the workspace itself). */
export async function openWorkspacePath(companyId: string, rel: string): Promise<void> {
  const root = resolve(store.requireCompany(companyId).workspaceDir);
  const target = resolve(root, rel === "" ? "." : rel);
  if (target !== root && !target.startsWith(root + sep))
    throw new Error("path escapes the workspace");
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

/** Open the product where it lives: a URL in the browser, a workspace path with its app. */
export async function openProduct(companyId: string): Promise<string> {
  const entry = productEntry(companyId) ?? "index.html";
  if (/^https?:\/\//.test(entry)) await shell.openExternal(entry);
  else await openWorkspacePath(companyId, entry);
  return entry;
}
