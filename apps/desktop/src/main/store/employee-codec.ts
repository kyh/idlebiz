import type { AgentRunner, Company, Employee, Product } from "@/shared/domain";
import { isRunnerId } from "@repo/agent-driver/runner";
import { employeeMemoryDir } from "@/main/paths";
import { standingInstructions } from "@/main/prompts/instructions";
import { PACKAGE_SCHEMA, optNum, optStr, reqStr } from "@/main/store/frontmatter";
import type { FrontmatterDoc } from "@/main/store/frontmatter";

const parseRunner = (v: string | null): AgentRunner => (v && isRunnerId(v) ? v : "codex");

export const employeeBody = (e: Employee, co: Company, products: readonly Product[]): string =>
  standingInstructions({
    company: co,
    employee: e,
    lead: co.leaderId === e.id,
    memoryDir: employeeMemoryDir(co.id, e.id),
    products,
  });

export const employeeToDoc = (
  e: Employee,
  co: Company,
  products: readonly Product[],
): FrontmatterDoc => {
  const metadata: FrontmatterDoc["metadata"] = {
    createdAt: e.createdAt,
    deskIndex: e.deskIndex,
    persona: e.persona,
    role: e.role,
    runner: e.runner,
    spriteSeed: e.spriteSeed,
    title: e.title,
  };
  return {
    body: employeeBody(e, co, products),
    fields: {
      description: e.title || e.role,
      kind: "agent",
      name: e.name,
      schema: PACKAGE_SCHEMA,
      slug: e.id,
    },
    metadata,
  };
};

export const docToEmployee = (doc: FrontmatterDoc, companyId: string): Employee => {
  const f = doc.fields;
  const m = doc.metadata;
  return {
    companyId,
    createdAt: optNum(m, "createdAt", Date.now()),
    deskIndex: optNum(m, "deskIndex", 0),
    id: reqStr(f, "slug"),
    instructionsDigest: null,
    lastRunMetrics: null,
    lastShip: null,
    name: reqStr(f, "name"),
    persona: optStr(m, "persona") ?? "",
    role: optStr(m, "role") ?? "general",
    runner: parseRunner(optStr(m, "runner")),
    // saves from before run-state.json kept the session here; adoptOlderSave moves it into run-state.json
    sessionId: optStr(m, "sessionId"),
    spriteSeed: optStr(m, "spriteSeed") ?? `emp-${reqStr(f, "slug")}`,
    status: "idle",
    title: optStr(m, "title") ?? optStr(f, "description") ?? "",
  };
};
