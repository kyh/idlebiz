import type { Routine } from "@/shared/domain";
import { PACKAGE_SCHEMA, nullableNum, optNum, optStr, reqStr } from "@/main/store/frontmatter";
import type { FrontmatterDoc } from "@/main/store/frontmatter";

export const routineToDoc = (r: Routine): FrontmatterDoc => {
  const metadata: FrontmatterDoc["metadata"] = { intervalHours: r.intervalHours };
  if (r.role !== null) {
    metadata.role = r.role;
  }
  if (r.lastRunAt !== null) {
    metadata.lastRunAt = r.lastRunAt;
  }
  return {
    body: `${r.instruction}\n`,
    fields: { name: r.name, schema: PACKAGE_SCHEMA, slug: r.id },
    metadata,
  };
};

export const docToRoutine = (doc: FrontmatterDoc, companyId: string): Routine => ({
  companyId,
  id: reqStr(doc.fields, "slug"),
  instruction: doc.body.trim(),
  intervalHours: optNum(doc.metadata, "intervalHours", 24),
  lastRunAt: nullableNum(doc.metadata, "lastRunAt"),
  name: reqStr(doc.fields, "name"),
  role: optStr(doc.metadata, "role"),
});
