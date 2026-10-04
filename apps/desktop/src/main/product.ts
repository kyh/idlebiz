import { readFileSync } from "node:fs";
import path from "node:path";
import { host } from "@/main/host";
import * as store from "@/main/store/store";
import { latestDeployment } from "@/main/vercel";
import { judgeAgentPath, judgeOpening } from "@/main/workspace-open";
import type { Opening } from "@/main/workspace-open";
import type { ProductStatus } from "@/shared/integrations";
import { RefusalError } from "@/shared/refusal";

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

// Finder, or the path's default app; a path the OS cannot open comes back as the host's refusal
const openTarget = async (opening: Opening): Promise<void> => {
  await host().open({
    kind: opening.kind === "reveal" ? "reveal" : "path",
    target: opening.path,
  });
};

/**
 * Open a path an agent wrote with the OS default app ("" is shared/ itself). Agents write
 * paths relative to the workspace they ran in, so a relative one is tried against shared/
 * and every product's workspace, and the first that has it wins.
 */
export const openWorkspacePath = async (rel: string): Promise<void> => {
  const opening = judgeAgentPath(
    [store.requireCompany().workspaceDir, ...store.listProducts().map((p) => p.workspaceDir)],
    rel,
  );
  if (opening === null) {
    throw new RefusalError("no such path in the workspace");
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
    await host().open({ kind: "url", target: entry });
    return entry;
  }
  const opening = judgeOpening([product.workspaceDir], entry);
  if (opening === null) {
    throw new RefusalError("the product's entry is not in its workspace");
  }
  await openTarget(opening);
  return entry;
};
