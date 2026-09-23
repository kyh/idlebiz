import type { Product } from "@/shared/domain";
import { companyWorkspace, productWorkspace } from "@/main/paths";
import {
  PACKAGE_SCHEMA,
  nullableNum,
  optNum,
  optStr,
  reqNum,
  reqStr,
} from "@/main/store/frontmatter";
import type { FrontmatterDoc } from "@/main/store/frontmatter";

/**
 * Which workspace, never where: the path is derived from ROOT_DIR at load, as
 * the company's is, so a save copied to another root works in its own tree.
 */
export const productToDoc = (p: Product): FrontmatterDoc => {
  const metadata: FrontmatterDoc["metadata"] = {
    createdAt: p.createdAt,
    ships: p.ships,
    workspace: p.workspaceDir === companyWorkspace(p.companyId) ? "company" : "own",
  };
  if (p.lastShipAt !== null) {
    metadata.lastShipAt = p.lastShipAt;
  }
  if (p.users !== null) {
    metadata.users = p.users;
  }
  if (p.revenueUsd !== null) {
    metadata.revenueUsd = p.revenueUsd;
  }
  if (p.vercel) {
    metadata.vercelProjectId = p.vercel.projectId;
    metadata.vercelProjectName = p.vercel.projectName;
    if (p.vercel.teamId !== null) {
      metadata.vercelTeamId = p.vercel.teamId;
    }
  }
  return {
    body: `${p.description}\n`,
    fields: { kind: "product", name: p.name, schema: PACKAGE_SCHEMA, slug: p.id },
    metadata,
  };
};

export const docToProduct = (doc: FrontmatterDoc, companyId: string): Product => {
  const m = doc.metadata;
  const projectId = optStr(m, "vercelProjectId");
  const id = reqStr(doc.fields, "slug");
  return {
    companyId,
    createdAt: reqNum(m, "createdAt"),
    description: doc.body.trim(),
    id,
    lastShipAt: nullableNum(m, "lastShipAt"),
    name: reqStr(doc.fields, "name"),
    revenueUsd: nullableNum(m, "revenueUsd"),
    ships: optNum(m, "ships", 0),
    users: nullableNum(m, "users"),
    vercel:
      projectId === null
        ? null
        : {
            projectId,
            projectName: optStr(m, "vercelProjectName") ?? projectId,
            teamId: optStr(m, "vercelTeamId"),
          },
    workspaceDir:
      optStr(m, "workspace") === "own"
        ? productWorkspace(companyId, id)
        : companyWorkspace(companyId),
  };
};
