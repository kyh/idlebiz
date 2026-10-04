// The company's work: the list, the shipping log, and the founder's answers, actions and sign-offs.

import { oc, type } from "@orpc/contract";
import type { ShipLine, Task } from "@repo/domain/domain";
import {
  answerInput,
  assignInput,
  listInput,
  resolveActionInput,
  resolveApprovalInput,
} from "./tasks-schema";

export const tasksContract = {
  /** Answers an employee's question. */
  answer: oc.input(answerInput).output(type<Task>()),
  assign: oc.input(assignInput).output(type<Task>()),
  list: oc.input(listInput).output(type<Task[]>()),
  /** The founder's Done or Can't on an action card. */
  resolveAction: oc.input(resolveActionInput).output(type<Task>()),
  /** The founder's sign-off on a held step, or its refusal. */
  resolveApproval: oc.input(resolveApprovalInput).output(type<Task>()),
  shipped: oc.output(type<ShipLine[]>()),
};
