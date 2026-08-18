// Safe accessors for narrowing parsed-JSON values (single parse-boundary
// narrowing — same pattern the pi-driver event parser established). All of
// them tolerate any input and never throw.

import { z } from "zod";

const jsonValueSchema = z.json();

/** The full domain of a `JSON.parse` result. */
export type JsonValue = z.infer<typeof jsonValueSchema>;

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export type JsonObject = z.infer<typeof jsonObjectSchema>;

export function obj(v: JsonValue | undefined): JsonObject {
  const parsed = jsonObjectSchema.safeParse(v);
  return parsed.success ? parsed.data : {};
}

export const str = (v: JsonValue | undefined): string | undefined => {
  const parsed = z.string().safeParse(v);
  return parsed.success ? parsed.data : undefined;
};

export const num = (v: JsonValue | undefined): number => {
  const parsed = z.number().safeParse(v);
  return parsed.success ? parsed.data : 0;
};

export const arr = (v: JsonValue | undefined): JsonValue[] => (Array.isArray(v) ? v : []);
