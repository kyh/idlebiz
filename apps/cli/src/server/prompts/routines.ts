import type { BusinessTypeId, Routine } from "@repo/domain/domain";

export type RoutineDefinition = Pick<Routine, "name" | "intervalHours" | "role" | "instruction">;

const BUSINESS_ROUTINES = {
  custom: null,
  ecommerce: {
    instruction:
      "Walk the storefront as a customer: product pages, copy, pricing, checkout. Check read_orders for any buyer waiting on an answer, then improve the weakest page.",
    intervalHours: 24,
    name: "Store audit",
    role: "market",
  },
  "game-studio": {
    instruction:
      "Play the current build end to end, up to the paid unlock. Log what's broken or unfun, then fix the worst issue or delegate it to the right teammate.",
    intervalHours: 24,
    name: "Playtest session",
    role: "design",
  },
  software: null,
  vc: {
    instruction:
      "Review the pipeline docs in the workspace, source 3 new early-stage companies from public information, and write or refresh one deal memo or teardown for what the firm sells.",
    intervalHours: 24,
    name: "Deal pipeline review",
    role: "analy",
  },
} satisfies Record<BusinessTypeId, RoutineDefinition | null>;

export const defaultRoutines = (businessType: BusinessTypeId) => {
  const preset = BUSINESS_ROUTINES[businessType];

  return (preset ? [preset] : []) satisfies readonly RoutineDefinition[];
};
