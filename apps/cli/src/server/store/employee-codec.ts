import { z } from "zod";
import type { Company, Employee, Product } from "@repo/domain/domain";
import { RUNNER_IDS } from "@repo/domain/runners";
import { employeeMemoryDir } from "../paths";
import { standingInstructions } from "../prompts/instructions";
import { PACKAGE_SCHEMA, decodeDoc, packageFields } from "./frontmatter";
import type { FrontmatterDoc } from "./frontmatter";

/** `description` is the package's one-line summary for other readers of the format; this app reads `title`. */
const EmployeeDocSchema = z.object({
  body: z.string(),
  fields: packageFields("agent").extend({ description: z.string() }),
  metadata: z.object({
    createdAt: z.number(),
    deskIndex: z.number().int().nonnegative(),
    persona: z.string(),
    role: z.string(),
    runner: z.enum(RUNNER_IDS),
    spriteSeed: z.string(),
    title: z.string(),
  }),
});

export const employeeBody = (e: Employee, co: Company, products: readonly Product[]): string =>
  standingInstructions({
    company: co,
    employee: e,
    lead: co.leaderId === e.id,
    memoryDir: employeeMemoryDir(e.id),
    products,
  });

export const employeeToDoc = (
  e: Employee,
  co: Company,
  products: readonly Product[],
): z.input<typeof EmployeeDocSchema> => ({
  body: employeeBody(e, co, products),
  fields: {
    description: e.title || e.role,
    kind: "agent",
    name: e.name,
    schema: PACKAGE_SCHEMA,
    slug: e.id,
  },
  metadata: {
    createdAt: e.createdAt,
    deskIndex: e.deskIndex,
    persona: e.persona,
    role: e.role,
    runner: e.runner,
    spriteSeed: e.spriteSeed,
    title: e.title,
  },
});

export const docToEmployee = (doc: FrontmatterDoc): Employee => {
  const { fields, metadata: m } = decodeDoc(EmployeeDocSchema, doc);
  return {
    createdAt: m.createdAt,
    deskIndex: m.deskIndex,
    id: fields.slug,
    instructionsDigest: null,
    lastRunMetrics: null,
    lastShip: null,
    name: fields.name,
    persona: m.persona,
    role: m.role,
    runner: m.runner,
    session: null,
    spriteSeed: m.spriteSeed,
    status: "idle",
    title: m.title,
  };
};
