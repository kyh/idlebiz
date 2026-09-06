import type { Employee } from "@/shared/domain";
export const employeeName = (
  employees: readonly Employee[],
  id: string | null | undefined,
  fallback: string,
): string => employees.find((e) => e.id === id)?.name ?? fallback;
