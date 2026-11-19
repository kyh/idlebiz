import { z } from "zod";
import type { Routine } from "@repo/domain/domain";
import { PACKAGE_SCHEMA, decodeDoc } from "./frontmatter";
import type { FrontmatterDoc } from "./frontmatter";

const RoutineDocSchema = z.object({
  body: z.string(),
  fields: z.object({ name: z.string(), schema: z.literal(PACKAGE_SCHEMA), slug: z.string() }),
  metadata: z.object({
    intervalHours: z.number().positive(),
    lastRunAt: z.number().optional(),
    role: z.string().optional(),
  }),
});

export const routineToDoc = (r: Routine) =>
  ({
    body: `${r.instruction}\n`,
    fields: { name: r.name, schema: PACKAGE_SCHEMA, slug: r.id },
    metadata: {
      intervalHours: r.intervalHours,
      lastRunAt: r.lastRunAt ?? undefined,
      role: r.role ?? undefined,
    },
  }) satisfies z.input<typeof RoutineDocSchema>;

export const docToRoutine = (doc: FrontmatterDoc) => {
  const { body, fields, metadata: m } = decodeDoc(RoutineDocSchema, doc);

  return {
    id: fields.slug,
    instruction: body.trim(),
    intervalHours: m.intervalHours,
    lastRunAt: m.lastRunAt ?? null,
    name: fields.name,
    role: m.role ?? null,
  } satisfies Routine;
};
