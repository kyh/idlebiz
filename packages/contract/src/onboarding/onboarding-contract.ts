// Founding a company: the hires to pick from, and the founding itself, whole or not at all.

import { oc, type } from "@orpc/contract";
import type { Company } from "@repo/domain/domain";
import type { HireProposal } from "@repo/domain/hire";
import { foundCompanyInput, generateHiresInput } from "./onboarding-schema";

export const onboardingContract = {
  found: oc.input(foundCompanyInput).output(type<Company>()),
  hires: oc.input(generateHiresInput).output(type<HireProposal[]>()),
};
