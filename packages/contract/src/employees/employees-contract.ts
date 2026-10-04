// The team: the roster, the founder's direct word to one, and what one can be asked.

import { oc, type } from "@orpc/contract";
import type { ChatOption, Employee } from "@repo/domain/domain";
import type { Done } from "../done";
import { directEmployeeInput, employeeOptionsInput } from "./employees-schema";

export const employeesContract = {
  direct: oc.input(directEmployeeInput).output(type<Done>()),
  list: oc.output(type<Employee[]>()),
  /** What the founder can say to an employee, from their open work. */
  options: oc.input(employeeOptionsInput).output(type<ChatOption[]>()),
};
