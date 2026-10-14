import type { MenuItem } from "@/renderer/ui/choice-menu";
import { STEP_ORDER } from "@/renderer/ui/onboarding-flow";
import type { Flow, Step, Team } from "@/renderer/ui/onboarding-flow";
import { BUSINESS_TYPES } from "@repo/domain/domain";

/** Each answer fills one of the founding markers. */
export const FOUNDING_STEPS: readonly Step[] = [
  "founder",
  "look",
  "company",
  "biztype",
  "pitch",
  "team",
  "budget",
];
export const completedSteps = (step: Step): number =>
  step === "finalize"
    ? FOUNDING_STEPS.length
    : FOUNDING_STEPS.filter((s) => STEP_ORDER.indexOf(s) < STEP_ORDER.indexOf(step)).length;

export const STEP_LABELS = {
  auth: "Connect your workforce",
  biztype: "Your business",
  budget: "Your budget",
  company: "Your company",
  finalize: "Open for business",
  founder: "The founder",
  intro: "Meet your first investor",
  look: "Your look",
  pitch: "Your big idea",
  team: "Your founding team",
  title: "IdleBiz",
} satisfies Record<Step, string>;

/** The caps on offer; null is the explicit "no ceiling" choice, not an absent one. */
export const CAPS: readonly (number | null)[] = [5, 20, 50, null];
export const CAP_ITEMS: readonly MenuItem[] = CAPS.map((cap) =>
  cap === null
    ? { hint: "No ceiling — the office uses whatever it needs", label: "No cap" }
    : { label: `$${cap}` },
);
export const DEFAULT_CAP_INDEX = 1;

export const BIZ_ITEMS: readonly MenuItem[] = BUSINESS_TYPES.map((b) => ({ label: b.label }));
export const LOOK_ITEMS: readonly MenuItem[] = [
  { label: "That's me" },
  { label: "Show me another" },
];
export const CAST_ITEMS: readonly MenuItem[] = [{ label: "Sign them" }, { label: "Search again" }];
export const FAILED_ITEMS: readonly MenuItem[] = [
  { label: "Search again" },
  { label: "Rewrite the pitch" },
];
export const OPEN_FAILED_ITEMS: readonly MenuItem[] = [{ label: "Try again" }];

const teamScript = (team: Team, pitched: boolean): readonly string[] => {
  switch (team.kind) {
    case "cast": {
      return [
        pitched
          ? "Boom. Founding team, cast for that exact pitch. I know people."
          : "Boom. Founding team, cast to find the idea themselves. They'll tell you what they try first.",
        "From here the team lead hires and fires on their own. You steer with the budget.",
      ];
    }
    case "failed": {
      return ["Huh. My recruiter isn't picking up. Want me to try again?"];
    }
    case "casting": {
      return ["Hang on, let me text my recruiter…", "…she's reviewing resumes…"];
    }
    // no default
  }
};

/** What Chad says at each step, a page at a time. The step's prompt opens
 *  under the last page. */
export const scriptFor = (
  flow: Flow,
  founderName: string,
  companyName: string,
  pitched: boolean,
): readonly string[] => {
  const you = founderName || "founder";
  const co = companyName || "your company";
  switch (flow.step) {
    case "title": {
      return [];
    }
    case "intro": {
      return [
        "Hey! Welcome to the world of IDLEBIZ!",
        "Chad Runwayson. I write checks. That office down the street? I own the building — and tonight it's yours, every floor of it, if you've got the nerve.",
        "This world runs on employees. They live in your coding CLI — Claude Code or Codex — and they write real code, in a real folder, on your computer. Real usage, too.",
      ];
    }
    case "auth": {
      return [
        "Hm. I don't see a coding CLI signed in on this machine. No CLI, no employees. Let's fix that first.",
      ];
    }
    case "founder": {
      return ["So. Tell me about the founder. What's your name?"];
    }
    case "look": {
      return [`${you}. Love it. And which of these is you?`];
    }
    case "company": {
      return [`Okay ${you}. The company you're founding — what's it called?`];
    }
    case "biztype": {
      return [`${co}. Strong name. What kind of company is ${co} going to be?`];
    }
    case "pitch": {
      return [
        `Now the pitch. What will ${co} build? Got nothing? Leave it blank — the team picks something and tells you.`,
      ];
    }
    case "team": {
      return teamScript(flow.team, pitched);
    }
    case "budget": {
      return [
        "Last thing, and it's the one I care about. Employees think with real AI, and I meter every run at API prices. Your plan may bill you less, but that's the number I watch.",
        "Set the usage ceiling. They down tools when they hit it, and you can move it any time.",
      ];
    }
    case "finalize": {
      return [`${co}! Your very own business legend starts tonight. Here are the keys — go.`];
    }
    // no default
  }
};

export const hintFor = (
  step: Step,
  look: number,
  looks: number,
  capUsd: number | null,
): string | null => {
  switch (step) {
    case "founder":
    case "company": {
      return "Enter ↵";
    }
    case "pitch": {
      return "Enter ↵ · blank lets the team pick · Shift+Enter for a new line";
    }
    case "look": {
      return looks > 1 ? `${look + 1} / ${looks} · ← → to browse` : null;
    }
    case "budget": {
      return capUsd === null
        ? "⚠ Uncapped. Usage keeps climbing while the office works."
        : `New work stops at $${capUsd} of usage; whatever is already running still finishes.`;
    }
    case "title":
    case "intro":
    case "auth":
    case "biztype":
    case "team":
    case "finalize": {
      return null;
    }
    // no default
  }
};
