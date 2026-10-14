// The team: the roster, the founder's direct word to one, and what one can be asked.

import { oc, type } from "@orpc/contract";
import { z } from "zod";
import type { ChatOption, Employee } from "@repo/domain/domain";
import type { Done } from "./done";

const directEmployeeInput = z.object({
  employeeId: z.string(),
  instruction: z.string().min(1).max(2000),
});

export const employeesContract = {
  direct: oc.input(directEmployeeInput).output(type<Done>()),
  list: oc.output(type<Employee[]>()),
  /** What the founder can say to an employee, from their open work. */
  options: oc.input(z.object({ employeeId: z.string() })).output(type<ChatOption[]>()),
};
