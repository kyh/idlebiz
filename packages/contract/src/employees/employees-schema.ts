import { z } from "zod";

export const directEmployeeInput = z.object({
  employeeId: z.string(),
  instruction: z.string().min(1).max(2000),
});
export const employeeOptionsInput = z.object({ employeeId: z.string() });
