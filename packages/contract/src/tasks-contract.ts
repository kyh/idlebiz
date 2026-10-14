// The company's work: the list, the shipping log, and the founder's answers, actions and sign-offs.

import { oc, type } from "@orpc/contract";
import { z } from "zod";
import { ActionReplySchema, OPEN_TASK_STATUSES } from "@repo/domain/domain";
import type { ShipLine, Task } from "@repo/domain/domain";

const listInput = z.object({
  assigneeId: z.string().optional(),
  status: z.array(z.enum(OPEN_TASK_STATUSES)).optional(),
});

export const tasksContract = {
  /** Answers an employee's question. */
  answer: oc.input(z.object({ answer: z.string(), taskId: z.string() })).output(type<Task>()),
  assign: oc.input(z.object({ employeeId: z.string(), taskId: z.string() })).output(type<Task>()),
  list: oc.input(listInput).output(type<Task[]>()),
  /** The founder's Done or Can't on an action card. */
  resolveAction: oc
    .input(z.object({ reply: ActionReplySchema, taskId: z.string() }))
    .output(type<Task>()),
  /** The founder's sign-off on a held step, or its refusal. */
  resolveApproval: oc
    .input(z.object({ approved: z.boolean(), taskId: z.string() }))
    .output(type<Task>()),
  shipped: oc.output(type<ShipLine[]>()),
};
