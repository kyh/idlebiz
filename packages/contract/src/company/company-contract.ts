// The one company this launch runs: its state, the founder's dials, the digest and its files.

import { oc, type } from "@orpc/contract";
import type { Digest } from "@repo/domain/digest";
import type { Company } from "@repo/domain/domain";
import type { Done } from "../done";
import {
  openCompanyPathInput,
  setAutopilotInput,
  setBudgetInput,
  setMaxAgentsInput,
} from "./company-schema";

export const companyContract = {
  /** Null before a company is founded. */
  get: oc.output(type<Company | null>()),
  /** Opens a file of the company's in Finder or its app. */
  openPath: oc.input(openCompanyPathInput).output(type<Done>()),
  resetSpend: oc.output(type<Company>()),
  setAutopilot: oc.input(setAutopilotInput).output(type<Company>()),
  setBudget: oc.input(setBudgetInput).output(type<Company>()),
  setMaxAgents: oc.input(setMaxAgentsInput).output(type<Company>()),
  /** What happened since the founder last looked; null before the first look, or with no company. */
  takeDigest: oc.output(type<Digest | null>()),
};
