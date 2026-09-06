import type { BusinessTypeId, Routine } from "@/shared/domain";

export type RoutineDefinition = Pick<Routine, "name" | "intervalHours" | "role" | "instruction">;

const COMMON_ROUTINES: readonly RoutineDefinition[] = [
  {
    name: "Business review",
    intervalHours: 24,
    role: null,
    instruction:
      "Step back and review the business: recent ships, team chat, and the product's current state. Identify the single weakest area (product, marketing, or distribution) and either fix it now or delegate it to the right teammate.",
  },
  {
    name: "Marketing push",
    intervalHours: 48,
    role: "market",
    instruction:
      "Produce one real piece of marketing for the product as it exists today: a launch/update post, landing copy, or outreach draft. Make it concrete and ready to publish. Ask the founder via ask_boss before posting anywhere public.",
  },
];

const BUSINESS_ROUTINES = {
  software: null,
  "game-studio": {
    name: "Playtest session",
    intervalHours: 24,
    role: "design",
    instruction:
      "Play the current build end to end. Log what's broken or unfun, then fix the worst issue or delegate it to the right teammate.",
  },
  vc: {
    name: "Deal pipeline review",
    intervalHours: 24,
    role: "analy",
    instruction:
      "Review the pipeline docs in the workspace, source 3 new candidate companies, and write or refresh one investment memo.",
  },
  ecommerce: {
    name: "Store audit",
    intervalHours: 24,
    role: "market",
    instruction:
      "Walk the storefront as a customer: product pages, copy, pricing, checkout. Improve the weakest page and draft one promotion.",
  },
  custom: null,
} satisfies Record<BusinessTypeId, RoutineDefinition | null>;

export function defaultRoutines(businessType: BusinessTypeId): readonly RoutineDefinition[] {
  const preset = BUSINESS_ROUTINES[businessType];
  return preset ? [...COMMON_ROUTINES, preset] : COMMON_ROUTINES;
}
