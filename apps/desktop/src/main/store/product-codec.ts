import type { Product } from "@/shared/domain";
import { nullableNum, optNum, optStr, reqNum, reqStr } from "@/main/store/frontmatter";
import type { FrontmatterDoc } from "@/main/store/frontmatter";

export const productToDoc = (p: Product): FrontmatterDoc => {
  const metadata: FrontmatterDoc["metadata"] = {
    createdAt: p.createdAt,
    ships: p.ships,
    workspaceDir: p.workspaceDir,
  };
  if (p.lastShipAt !== null) {
    metadata.lastShipAt = p.lastShipAt;
  }
  if (p.users !== null) {
    metadata.users = p.users;
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
    fields: { kind: "product", name: p.name, schema: "agentcompanies/v1", slug: p.id },
    metadata,
  };
};

export const docToProduct = (doc: FrontmatterDoc, companyId: string): Product => {
  const m = doc.metadata;
  const projectId = optStr(m, "vercelProjectId");
  return {
    companyId,
    createdAt: reqNum(m, "createdAt"),
    description: doc.body.trim(),
    id: reqStr(doc.fields, "slug"),
    lastShipAt: nullableNum(m, "lastShipAt"),
    name: reqStr(doc.fields, "name"),
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
    workspaceDir: reqStr(m, "workspaceDir"),
  };
};
