import { readFileSync } from "node:fs";
import path from "node:path";
import { shell } from "electron";
import * as store from "@/main/store/store";
import { latestDeployment } from "@/main/vercel";
import { judgeOpening } from "@/main/workspace-open";
import type { Opening } from "@/main/workspace-open";
import type { ProductStatus } from "@/shared/integrations";

// Where a product is, as the team points at it: PRODUCT.md at the product's
// workspace root carries an `entry:` line naming a path there or a URL. Nothing
// in the app writes it; the agents' standing instructions ask them to.

/** What the product's PRODUCT.md `entry:` names, if the team wrote one. */
const productEntry = (productId: string): string | null => {
  const { workspaceDir } = store.requireProduct(productId);
  try {
    const text = readFileSync(path.join(workspaceDir, "PRODUCT.md"), "utf-8");
    const entry = /^\s*`?entry`?\s*:\s*`?(?<entry>[^`\n]+?)`?\s*$/mu.exec(text)?.groups?.entry;
    return entry?.trim() ?? null;
  } catch {
    return null;
  }
};

const openTarget = async (opening: Opening): Promise<void> => {
  if (opening.kind === "reveal") {
    shell.showItemInFolder(opening.path);
    return;
  }
  const err = await shell.openPath(opening.path);
  if (err) {
    throw new Error(err);
  }
};

/**
 * Open a workspace-relative path with the OS default app ("" is the company
 * workspace itself). Agents write paths relative to the workspace they ran in,
 * so the path is tried against the company's and every product's, and the
 * first that has it wins.
 */
export const openWorkspacePath = async (rel: string): Promise<void> => {
  const opening = judgeOpening(
    [store.requireCompany().workspaceDir, ...store.listProducts().map((p) => p.workspaceDir)],
    rel,
  );
  if (opening === null) {
    throw new Error("no such path in the workspace");
  }
  await openTarget(opening);
};

/** Where a product really is: its entry, and the latest deploy when it is bound to one. */
export const productStatus = async (productId: string): Promise<ProductStatus> => {
  const { vercel } = store.requireProduct(productId);
  const deploy = vercel
    ? await latestDeployment(vercel.projectId, vercel.teamId ?? undefined)
    : null;
  return { deploy, entry: productEntry(productId) };
};

/** Open the product where it lives: a URL in the browser, a path in its workspace with its app. */
export const openProduct = async (productId: string): Promise<string> => {
  const product = store.requireProduct(productId);
  const entry = productEntry(productId) ?? "index.html";
  if (/^https?:\/\//u.test(entry)) {
    await shell.openExternal(entry);
    return entry;
  }
  const opening = judgeOpening([product.workspaceDir], entry);
  if (opening === null) {
    throw new Error("entry is not in the product's workspace");
  }
  await openTarget(opening);
  return entry;
};
