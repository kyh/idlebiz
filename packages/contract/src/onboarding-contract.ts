// Founding a company: the hires to pick from, and the founding itself, whole or not at all.

import { oc, type } from "@orpc/contract";
import { z } from "zod";
import { BudgetSchema } from "@repo/domain/domain";
import type { Company } from "@repo/domain/domain";
import { BusinessTypeSchema, HireProposalSchema } from "@repo/domain/hire";
import type { HireProposal } from "@repo/domain/hire";

const foundCompanyInput = z.object({
  // the cap is set at creation: the scheduler can spend on its first tick
  budget: BudgetSchema,
  businessType: BusinessTypeSchema,
  founderName: z.string(),
  founderSpriteSeed: z.string(),
  hires: z.array(HireProposalSchema).min(1),
  mission: z.string().trim().min(1).nullable(),
  name: z.string(),
});
const generateHiresInput = z.object({
  businessType: BusinessTypeSchema,
  companyName: z.string(),
  mission: z.string().trim().min(1).nullable(),
});

export const onboardingContract = {
  found: oc.input(foundCompanyInput).output(type<Company>()),
  hires: oc.input(generateHiresInput).output(type<HireProposal[]>()),
};
