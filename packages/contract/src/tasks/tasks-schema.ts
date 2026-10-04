import { z } from "zod";
import { ActionReplySchema, OPEN_TASK_STATUSES } from "@repo/domain/domain";

export const answerInput = z.object({ answer: z.string(), taskId: z.string() });
export const assignInput = z.object({ employeeId: z.string(), taskId: z.string() });
export const listInput = z.object({
  assigneeId: z.string().optional(),
  status: z.array(z.enum(OPEN_TASK_STATUSES)).optional(),
});
export const resolveActionInput = z.object({ reply: ActionReplySchema, taskId: z.string() });
export const resolveApprovalInput = z.object({ approved: z.boolean(), taskId: z.string() });
