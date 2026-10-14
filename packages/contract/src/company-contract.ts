// The one company this launch runs: its state, the founder's dials, the digest and its files.

import { oc, type } from "@orpc/contract";
import { z } from "zod";
import type { Digest } from "@repo/domain/digest";
import { BudgetSchema, MaxAgentsSchema } from "@repo/domain/domain";
import type { Company } from "@repo/domain/domain";
import type { Done } from "./done";

export const companyContract = {
  /** Null before a company is founded. */
  get: oc.output(type<Company | null>()),
  /** Opens a file of the company's in Finder or its app. */
  openPath: oc.input(z.object({ rel: z.string() })).output(type<Done>()),
  resetSpend: oc.output(type<Company>()),
  setAutopilot: oc.input(z.object({ running: z.boolean() })).output(type<Company>()),
  setBudget: oc.input(z.object({ budget: BudgetSchema })).output(type<Company>()),
  setMaxAgents: oc.input(z.object({ maxAgents: MaxAgentsSchema })).output(type<Company>()),
  /** What happened since the founder last looked; null before the first look, or with no company. */
  takeDigest: oc.output(type<Digest | null>()),
};
