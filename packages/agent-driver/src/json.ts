// Safe accessors for narrowing parsed-JSON values (single parse-boundary
// narrowing — same pattern the pi-driver event parser established). All of
// them tolerate any input and never throw.

export function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
