import type { Employee } from "@/shared/domain";

/** Who an id names — or `fallback` for anyone the roster no longer lists (or never did). */
export const employeeName = (
  employees: readonly Employee[],
  id: string | null | undefined,
  fallback: string,
): string => employees.find((e) => e.id === id)?.name ?? fallback;
