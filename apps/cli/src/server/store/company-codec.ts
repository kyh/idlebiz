import { z } from "zod";
import type { Budget, Company } from "@repo/domain/domain";
import { BUSINESS_TYPE_IDS } from "@repo/domain/domain";
import { sharedDir } from "../paths";
import { PACKAGE_SCHEMA, decodeDoc, packageFields } from "./frontmatter";
import type { FrontmatterDoc } from "./frontmatter";

/**
 * What this build writes, and the only stamp it reads. A save stamped higher was written by a
 * newer build: writers rebuild every file from what they understand, so opening it would quietly
 * drop whatever the newer build added. One stamped lower was written by a pre-release build whose
 * shapes nothing here reads. Both are refused, and a bump starts every save over.
 */
export const SAVE_FORMAT = 16;

/**
 * A save stamped at a format this build does not write, which nothing here touches: a newer
 * build's, which updating the app opens, or a pre-release build's (lower, or unstamped), which
 * no code reads.
 */
export class SaveFormatError extends Error {
  readonly writtenBy: "newer" | "pre-release";

  constructor(format: number | null) {
    const writtenBy = format !== null && format > SAVE_FORMAT ? "newer" : "pre-release";
    const stamp = format === null ? "no format stamp" : `format ${format}`;
    super(
      writtenBy === "newer"
        ? `this save was written by a newer IdleBiz (${stamp}, this build reads ${SAVE_FORMAT}) — update the app to open it`
        : `this save was made by a pre-release IdleBiz (${stamp}, this build reads ${SAVE_FORMAT}) — move it out of the save folder to start a new company`,
    );
    this.name = "SaveFormatError";
    this.writtenBy = writtenBy;
  }
}

/** Only a capped budget names its cap. */
const BudgetFieldsSchema = z.discriminatedUnion("budgetMode", [
  z.object({ budgetMode: z.literal("infinite") }),
  z.object({ budgetCapUsd: z.number().nonnegative(), budgetMode: z.literal("capped") }),
]);

/** A null field gets no line. */
const CompanyDocSchema = z.object({
  body: z.string(),
  fields: packageFields("company").extend({ description: z.string().min(1).optional() }),
  metadata: z.intersection(
    z.object({
      autopilot: z.boolean(),
      businessType: z.enum(BUSINESS_TYPE_IDS),
      createdAt: z.number(),
      format: z.literal(SAVE_FORMAT),
      founderName: z.string(),
      founderSpriteSeed: z.string(),
      leaderId: z.string().optional(),
      maxAgents: z.number().int().min(1),
      revenueUsd: z.number().optional(),
      ships: z.number().int().nonnegative(),
      spentUsd: z.number().nonnegative(),
      users: z.number().optional(),
    }),
    BudgetFieldsSchema,
  ),
});

const budgetFields = (budget: Budget): z.input<typeof BudgetFieldsSchema> =>
  budget.mode === "capped"
    ? { budgetCapUsd: budget.capUsd, budgetMode: "capped" }
    : { budgetMode: "infinite" };

const budgetOf = (m: z.output<typeof BudgetFieldsSchema>): Budget =>
  m.budgetMode === "capped" ? { capUsd: m.budgetCapUsd, mode: "capped" } : { mode: "infinite" };

export const companyToDoc = (co: Company): z.input<typeof CompanyDocSchema> => {
  const mission = co.mission === "" ? null : co.mission;
  return {
    body: mission === null ? `# ${co.name}\n` : `# ${co.name}\n\n${mission}\n`,
    fields: {
      description: mission ?? undefined,
      kind: "company",
      name: co.name,
      schema: PACKAGE_SCHEMA,
      slug: co.id,
    },
    metadata: {
      autopilot: co.autopilot,
      businessType: co.businessType,
      createdAt: co.createdAt,
      format: SAVE_FORMAT,
      founderName: co.founderName,
      founderSpriteSeed: co.founderSpriteSeed,
      leaderId: co.leaderId ?? undefined,
      maxAgents: co.maxAgents,
      // real metrics: absent keys mean "no source has ever reported"
      revenueUsd: co.revenueUsd ?? undefined,
      ships: co.ships,
      spentUsd: co.spentUsd,
      users: co.users ?? undefined,
      ...budgetFields(co.budget),
    },
  };
};

/** The format a COMPANY.md is stamped with; null when it carries none. */
export const formatOf = (doc: FrontmatterDoc): number | null => {
  const stamp = z.number().safeParse(doc.metadata.format);
  return stamp.success ? stamp.data : null;
};

export const docToCompany = (doc: FrontmatterDoc): Company => {
  const format = formatOf(doc);
  if (format !== SAVE_FORMAT) {
    throw new SaveFormatError(format);
  }
  const { fields, metadata: m } = decodeDoc(CompanyDocSchema, doc);
  return {
    autopilot: m.autopilot,
    budget: budgetOf(m),
    businessType: m.businessType,
    createdAt: m.createdAt,
    founderName: m.founderName,
    founderSpriteSeed: m.founderSpriteSeed,
    id: fields.slug,
    leaderId: m.leaderId ?? null,
    maxAgents: m.maxAgents,
    mission: fields.description ?? null,
    name: fields.name,
    revenueUsd: m.revenueUsd ?? null,
    ships: m.ships,
    spentUsd: m.spentUsd,
    users: m.users ?? null,
    workspaceDir: sharedDir(),
  };
};
