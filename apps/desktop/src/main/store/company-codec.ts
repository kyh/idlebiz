import type { Budget, BusinessTypeId, Company } from "@/shared/domain";
import { BUSINESS_TYPES, DEFAULT_FOUNDER_SEED, DEFAULT_MAX_AGENTS } from "@/shared/domain";
import { companySharedDir } from "@/main/paths";
import {
  PACKAGE_SCHEMA,
  nullableNum,
  optBool,
  optNum,
  optStr,
  reqNum,
  reqStr,
} from "@/main/store/frontmatter";
import type { FrontmatterDoc } from "@/main/store/frontmatter";

/**
 * What this build writes. A save stamped higher was written by a newer build:
 * writers rebuild every file from what they understand, so opening it would
 * quietly drop whatever the newer build added. It is refused instead. A save
 * stamped lower is adopted once at boot, then carries this stamp.
 */
export const SAVE_FORMAT = 6;

export const formatOf = (doc: FrontmatterDoc): number => optNum(doc.metadata, "format", 0);

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
  return {
    body: `# ${co.name}\n\n${co.mission}\n`,
    fields: {
      description: co.mission,
      kind: "company",
      name: co.name,
      schema: PACKAGE_SCHEMA,
      slug: co.id,
    },
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
    throw new Error(
      `this save was written by a newer IdleBiz (format ${formatOf(doc)}, this build reads ${SAVE_FORMAT}) — update the app to open it`,
    );
  }
  const f = doc.fields;
  const m = doc.metadata;
  const id = reqStr(f, "slug");
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
    mission: optStr(f, "description") ?? "",
    name: reqStr(f, "name"),
    revenueUsd: nullableNum(m, "revenueUsd"),
    ships: optNum(m, "ships", 0),
    spentUsd: Math.max(0, optNum(m, "spentUsd", 0)),
    users: nullableNum(m, "users"),
    workspaceDir: companySharedDir(id),
  };
};
