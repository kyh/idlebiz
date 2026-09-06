import { businessTypeById, type BusinessTypeId } from "@/shared/domain";

const HIRE_HINTS = {
  software: "Lean product team: engineers, a designer, and someone on growth/marketing.",
  "game-studio": "A game needs gameplay engineering, pixel art, sound, and game design.",
  vc: "An investment firm needs sourcing, analysis/research, and investor-facing writing.",
  ecommerce: "A shop needs product/merchandising, storefront engineering, ops, and marketing.",
  custom: "",
} satisfies Record<BusinessTypeId, string>;

export function foundingTeamPrompt(
  companyName: string,
  mission: string,
  businessType: BusinessTypeId,
): string {
  const typeHint =
    businessType === "custom"
      ? ""
      : `\nBusiness type: ${businessTypeById(businessType).label}. ${HIRE_HINTS[businessType]}`;
  return `You are casting the founding team of a startup for a business-sim game.

Company: ${companyName}
Pitch: ${mission}${typeHint}

Invent 5 distinct hires tailored to THIS pitch — whatever business it is. Mix the roles sensibly (a game needs gameplay + art + audio; a newsletter needs research + writing + editing; an investment firm needs sourcing + analysis + IR; a shop needs product + ops + marketing). Each person gets:
- name: a memorable first name (diverse, varied)
- role: a short lowercase role key like "engineer", "pixel-artist", "writer"
- title: their job title
- persona: 2-3 sentences of working style + personality that will be used as their AI system prompt — concrete, vivid, useful
- blurb: a fun one-line resume hook

Reply with ONLY a JSON array of 5 objects with keys name, role, title, persona, blurb. No markdown fence, no commentary.`;
}
