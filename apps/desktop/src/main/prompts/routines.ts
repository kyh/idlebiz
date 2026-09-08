import type { BusinessTypeId, Routine } from "@/shared/domain";

export type RoutineDefinition = Pick<Routine, "name" | "intervalHours" | "role" | "instruction">;

const COMMON_ROUTINES: readonly RoutineDefinition[] = [
  {
    instruction:
      "Step back and review the business: recent ships, team chat, and the product's current state. Identify the single weakest area (product, marketing, or distribution) and either fix it now or delegate it to the right teammate.",
    intervalHours: 24,
    name: "Business review",
    role: null,
  },
  {
    instruction:
      "Produce one real piece of marketing for the product as it exists today: a launch/update post, landing copy, or outreach draft. Make it concrete and ready to publish. Ask the founder via ask_boss before posting anywhere public.",
    intervalHours: 48,
    name: "Marketing push",
    role: "market",
  },
];

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
  return preset ? [...COMMON_ROUTINES, preset] : COMMON_ROUTINES;
};
