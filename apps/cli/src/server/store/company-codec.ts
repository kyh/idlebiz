import type { Budget, BusinessTypeId, Company } from "@repo/domain/domain";
import { BUSINESS_TYPES, DEFAULT_FOUNDER_SEED, DEFAULT_MAX_AGENTS } from "@repo/domain/domain";
import { companySharedDir } from "../paths";
import {
  PACKAGE_SCHEMA,
  nullableNum,
  optBool,
  optNum,
  optStr,
  reqNum,
  reqStr,
} from "./frontmatter";
import type { FrontmatterDoc } from "./frontmatter";

/**
 * What this build writes. A save stamped higher was written by a newer build:
 * writers rebuild every file from what they understand, so opening it would
 * quietly drop whatever the newer build added. It is refused instead. A save
 * stamped lower is adopted once at boot, then carries this stamp.
 */
export const SAVE_FORMAT = 11;

export const formatOf = (doc: FrontmatterDoc): number => optNum(doc.metadata, "format", 0);

/** A save stamped higher than SAVE_FORMAT: updating the app opens it, and nothing here should touch it. */
export class NewerSaveError extends Error {
  constructor(format: number) {
    super(
      `this save was written by a newer IdleBiz (format ${format}, this build reads ${SAVE_FORMAT}) — update the app to open it`,
    );
    this.name = "NewerSaveError";
  }
}

export const companyToDoc = (co: Company): FrontmatterDoc => {
  const metadata: FrontmatterDoc["metadata"] = {
    autopilot: co.autopilot,
    businessType: co.businessType,
    founderName: co.founderName,
    founderSpriteSeed: co.founderSpriteSeed,
    maxAgents: co.maxAgents,
    ships: co.ships,
  };
  if (co.leaderId !== null) {
    metadata.leaderId = co.leaderId;
  }
  // real metrics: absent keys mean "no source has ever reported"
  if (co.revenueUsd !== null) {
    metadata.revenueUsd = co.revenueUsd;
  }
  if (co.users !== null) {
    metadata.users = co.users;
  }
  metadata.budgetMode = co.budget.mode;
  if (co.budget.mode === "capped") {
    metadata.budgetCapUsd = co.budget.capUsd;
  }
  metadata.spentUsd = co.spentUsd;
  metadata.createdAt = co.createdAt;
  metadata.format = SAVE_FORMAT;
  const mission = co.mission === "" ? null : co.mission;
  const fields: FrontmatterDoc["fields"] = {};
  if (mission !== null) {
    fields.description = mission;
  }
  fields.kind = "company";
  fields.name = co.name;
  fields.schema = PACKAGE_SCHEMA;
  fields.slug = co.id;
  return {
    body: mission === null ? `# ${co.name}\n` : `# ${co.name}\n\n${mission}\n`,
    fields,
    metadata,
  };
};

const parseBusinessType = (raw: string | null): BusinessTypeId => {
  const found = BUSINESS_TYPES.find((b) => b.id === raw);
  return found ? found.id : "custom";
};

const parseBudget = (m: FrontmatterDoc["metadata"]): Budget => {
  if (optStr(m, "budgetMode") === "capped") {
    return { capUsd: Math.max(0, optNum(m, "budgetCapUsd", 0)), mode: "capped" };
  }
  return { mode: "infinite" };
};

export const docToCompany = (doc: FrontmatterDoc): Company => {
  if (formatOf(doc) > SAVE_FORMAT) {
    throw new NewerSaveError(formatOf(doc));
  }
  const f = doc.fields;
  const m = doc.metadata;
  const id = reqStr(f, "slug");
  const description = optStr(f, "description");
  return {
    autopilot: optBool(m, "autopilot", true),
    budget: parseBudget(m),
    businessType: parseBusinessType(optStr(m, "businessType")),
    createdAt: reqNum(m, "createdAt"),
    founderName: optStr(m, "founderName") ?? "Founder",
    founderSpriteSeed: optStr(m, "founderSpriteSeed") ?? DEFAULT_FOUNDER_SEED,
    id,
    leaderId: optStr(m, "leaderId"),
    maxAgents: Math.max(1, optNum(m, "maxAgents", DEFAULT_MAX_AGENTS)),
    mission: description === null || description === "" ? null : description,
    name: reqStr(f, "name"),
    revenueUsd: nullableNum(m, "revenueUsd"),
    ships: optNum(m, "ships", 0),
    spentUsd: Math.max(0, optNum(m, "spentUsd", 0)),
    users: nullableNum(m, "users"),
    workspaceDir: companySharedDir(id),
  };
};
