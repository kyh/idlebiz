import { z } from "zod";
import { BUSINESS_TYPE_IDS } from "@/shared/domain";

export const BusinessTypeSchema = z.enum(BUSINESS_TYPE_IDS);

/** An LLM-proposed hire, as cast: the shape the roster generator must produce. */
export const HireCandidateSchema = z.object({
  blurb: z.string().min(2).max(120),
  name: z.string().min(1).max(40),
  persona: z.string().min(10).max(600),
  role: z
    .string()
    .min(2)
    .max(32)
    .transform((s) => s.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")),
  title: z.string().min(2).max(60),
});

export type HireCandidate = z.infer<typeof HireCandidateSchema>;

/** A candidate the founder can hire: main has given them a look. */
export const HireProposalSchema = HireCandidateSchema.extend({ spriteSeed: z.string() });

export type HireProposal = z.infer<typeof HireProposalSchema>;
