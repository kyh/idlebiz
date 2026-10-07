import { z } from "zod";
import { BudgetSchema } from "@repo/domain/domain";
import { BusinessTypeSchema, HireProposalSchema } from "@repo/domain/hire";

export const foundCompanyInput = z.object({
  // the cap is set at creation: the scheduler can spend on its first tick
  budget: BudgetSchema,
  businessType: BusinessTypeSchema,
  founderName: z.string(),
  founderSpriteSeed: z.string(),
  hires: z.array(HireProposalSchema).min(1),
  mission: z.string().trim().min(1).nullable(),
  name: z.string(),
});
export const generateHiresInput = z.object({
  businessType: BusinessTypeSchema,
  companyName: z.string(),
  mission: z.string().trim().min(1).nullable(),
});
