import type { Product } from "@/shared/domain";
import {
  nullableNum,
  optNum,
  optStr,
  reqNum,
  reqStr,
  type FrontmatterDoc,
} from "@/main/store/frontmatter";

// PRODUCT.md ⇄ Product. Pure, so it round-trips under test.

export function productToDoc(p: Product): FrontmatterDoc {
  const metadata: FrontmatterDoc["metadata"] = {
    workspaceDir: p.workspaceDir,
    ships: p.ships,
    createdAt: p.createdAt,
  };
  if (p.lastShipAt !== null) metadata.lastShipAt = p.lastShipAt;
  if (p.users !== null) metadata.users = p.users;
  if (p.vercel) {
    metadata.vercelProjectId = p.vercel.projectId;
    metadata.vercelProjectName = p.vercel.projectName;
    if (p.vercel.teamId !== null) metadata.vercelTeamId = p.vercel.teamId;
  }
  return {
    fields: { schema: "agentcompanies/v1", kind: "product", slug: p.id, name: p.name },
    metadata,
    body: `${p.description}\n`,
  };
}

export function docToProduct(doc: FrontmatterDoc, companyId: string): Product {
  const m = doc.metadata;
  const projectId = optStr(m, "vercelProjectId");
  return {
    id: reqStr(doc.fields, "slug"),
    companyId,
    name: reqStr(doc.fields, "name"),
    description: doc.body.trim(),
    workspaceDir: reqStr(m, "workspaceDir"),
    ships: optNum(m, "ships", 0),
    lastShipAt: nullableNum(m, "lastShipAt"),
    users: nullableNum(m, "users"),
    vercel:
      projectId === null
        ? null
        : {
            projectId,
            projectName: optStr(m, "vercelProjectName") ?? projectId,
            teamId: optStr(m, "vercelTeamId"),
          },
    createdAt: reqNum(m, "createdAt"),
  };
}
