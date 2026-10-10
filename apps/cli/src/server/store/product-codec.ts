import { z } from "zod";
import type { Product, VercelBinding } from "@repo/domain/domain";
import { COMPANY_WORKSPACE, productWorkspace } from "../paths";
import { PACKAGE_SCHEMA, decodeDoc, packageFields } from "./frontmatter";
import type { FrontmatterDoc } from "./frontmatter";

/** A null field gets no line; a Vercel binding is its project's id and name, or neither. */
const ProductDocSchema = z.object({
  body: z.string(),
  fields: packageFields("product"),
  metadata: z.object({
    createdAt: z.number(),
    lastShipAt: z.number().optional(),
    revenueUsd: z.number().optional(),
    ships: z.number().int().nonnegative(),
    users: z.number().optional(),
    vercelProjectId: z.string().optional(),
    vercelProjectName: z.string().optional(),
    vercelTeamId: z.string().optional(),
    workspace: z.enum(["company", "own"]),
  }),
});

type ProductMetadata = z.output<typeof ProductDocSchema>["metadata"];

const vercelOf = (m: ProductMetadata): VercelBinding | null => {
  const { vercelProjectId: projectId, vercelProjectName: projectName, vercelTeamId } = m;
  if (projectId === undefined && projectName === undefined) {
    return null;
  }
  if (projectId === undefined || projectName === undefined) {
    throw new Error("a Vercel binding names its project's id and name, or neither");
  }
  return { projectId, projectName, teamId: vercelTeamId ?? null };
};

/**
 * Which workspace, never where: the path is derived from ROOT_DIR at load, as
 * the company's is, so a save copied to another root works in its own tree.
 */
export const productToDoc = (p: Product): z.input<typeof ProductDocSchema> => ({
  body: `${p.description}\n`,
  fields: { kind: "product", name: p.name, schema: PACKAGE_SCHEMA, slug: p.id },
  metadata: {
    createdAt: p.createdAt,
    lastShipAt: p.lastShipAt ?? undefined,
    revenueUsd: p.revenueUsd ?? undefined,
    ships: p.ships,
    users: p.users ?? undefined,
    vercelProjectId: p.vercel?.projectId,
    vercelProjectName: p.vercel?.projectName,
    vercelTeamId: p.vercel?.teamId ?? undefined,
    workspace: p.workspaceDir === COMPANY_WORKSPACE ? "company" : "own",
  },
});

export const docToProduct = (doc: FrontmatterDoc): Product => {
  const { body, fields, metadata: m } = decodeDoc(ProductDocSchema, doc);
  return {
    createdAt: m.createdAt,
    description: body.trim(),
    id: fields.slug,
    lastShipAt: m.lastShipAt ?? null,
    name: fields.name,
    revenueUsd: m.revenueUsd ?? null,
    ships: m.ships,
    users: m.users ?? null,
    vercel: vercelOf(m),
    workspaceDir: m.workspace === "own" ? productWorkspace(fields.slug) : COMPANY_WORKSPACE,
  };
};
