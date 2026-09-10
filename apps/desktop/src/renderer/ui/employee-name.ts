import type { Employee } from "@/shared/domain";

export const employeeName = (
  employees: readonly Employee[],
  id: string | null | undefined,
  fallback: string,
): string => employees.find((e) => e.id === id)?.name ?? fallback;

/** What their card says under the name: the title they were hired with, else the role. */
export const jobTitle = (emp: Pick<Employee, "title" | "role">): string => emp.title || emp.role;
