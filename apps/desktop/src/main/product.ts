import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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

/** Open a workspace-relative path with the OS default app ("" is the workspace itself). */
export async function openWorkspacePath(companyId: string, rel: string): Promise<void> {
  const root = resolve(store.requireCompany(companyId).workspaceDir);
  const target = resolve(root, rel === "" ? "." : rel);
  if (target !== root && !target.startsWith(root + sep))
    throw new Error("path escapes the workspace");
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
