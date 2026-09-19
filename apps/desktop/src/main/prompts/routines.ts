import type { BusinessTypeId, Routine } from "@/shared/domain";

export type RoutineDefinition = Pick<Routine, "name" | "intervalHours" | "role" | "instruction">;

// Only work that recurs by nature is a routine. Reviewing the business and
// marketing the product are not: a bet does both with a budget and a verdict,
// and a routine doing them spends outside every bet.
const BUSINESS_ROUTINES = {
  custom: null,
  ecommerce: {
    instruction:
      "Walk the storefront as a customer: product pages, copy, pricing, checkout. Improve the weakest page and draft one promotion.",
    intervalHours: 24,
    name: "Store audit",
    role: "market",
  },
  "game-studio": {
    instruction:
      "Play the current build end to end. Log what's broken or unfun, then fix the worst issue or delegate it to the right teammate.",
    intervalHours: 24,
    name: "Playtest session",
    role: "design",
  },
  software: null,
  vc: {
    instruction:
      "Review the pipeline docs in the workspace, source 3 new candidate companies, and write or refresh one investment memo.",
    intervalHours: 24,
    name: "Deal pipeline review",
    role: "analy",
  },
} satisfies Record<BusinessTypeId, RoutineDefinition | null>;

export const defaultRoutines = (businessType: BusinessTypeId): readonly RoutineDefinition[] => {
  const preset = BUSINESS_ROUTINES[businessType];
  return preset ? [preset] : [];
};

/** Seeded slugs no company should run any more: the work belongs to bets, so boot removes them from a save. */
export const RETIRED_ROUTINES: readonly string[] = ["business-review", "marketing-push"];
