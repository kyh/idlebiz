import { businessTypeById } from "@/shared/domain";
import type { BusinessTypeId } from "@/shared/domain";

const HIRE_HINTS = {
  custom: "",
  ecommerce: "A shop needs product/merchandising, storefront engineering, ops, and marketing.",
  "game-studio": "A game needs gameplay engineering, pixel art, sound, and game design.",
  software: "Lean product team: engineers, a designer, and someone on growth/marketing.",
  vc: "An investment firm needs sourcing, analysis/research, and investor-facing writing.",
} satisfies Record<BusinessTypeId, string>;

export const foundingTeamPrompt = (
  companyName: string,
  mission: string,
  businessType: BusinessTypeId,
): string => {
  const typeHint =
    businessType === "custom"
      ? ""
      : `\nBusiness type: ${businessTypeById(businessType).label}. ${HIRE_HINTS[businessType]}`;
  return `You are casting the founding team of a startup for a business-sim game.

Company: ${companyName}
Pitch: ${mission}${typeHint}

Invent 5 distinct hires tailored to THIS pitch — whatever business it is. List first the one who runs the company day to day: they decide what the team bets its time and money on, hire and let go, and hand out the work, so give them a title that says so (General Manager, Head of Product, Studio Director…) and a persona that decides rather than builds. Mix the roles sensibly (a game needs gameplay + art + audio; a newsletter needs research + writing + editing; an investment firm needs sourcing + analysis + IR; a shop needs product + ops + marketing). Each person gets:
- name: a memorable first name (diverse, varied)
- role: a short lowercase role key like "engineer", "pixel-artist", "writer"
- title: their job title
- persona: 2-3 sentences of working style + personality that will be used as their AI system prompt — concrete, vivid, useful
- blurb: a fun one-line resume hook

Reply with ONLY a JSON array of 5 objects with keys name, role, title, persona, blurb. No markdown fence, no commentary.`;
};
