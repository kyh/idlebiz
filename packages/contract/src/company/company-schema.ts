import { z } from "zod";
import { BudgetSchema, MaxAgentsSchema } from "@repo/domain/domain";

export const openCompanyPathInput = z.object({ rel: z.string() });
export const setAutopilotInput = z.object({ running: z.boolean() });
export const setBudgetInput = z.object({ budget: BudgetSchema });
export const setMaxAgentsInput = z.object({ maxAgents: MaxAgentsSchema });
