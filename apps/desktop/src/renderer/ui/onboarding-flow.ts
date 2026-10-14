import type { Auth } from "@/renderer/hooks/use-auth-flow";
import type { HireProposal } from "@repo/domain/hire";

export const STEP_ORDER = [
  "title",
  "intro",
  "auth",
  "founder",
  "look",
  "company",
  "biztype",
  "pitch",
  "team",
  "budget",
  "finalize",
] as const;
export type Step = (typeof STEP_ORDER)[number];

/** A step before any team is cast. */
type Teamless = Exclude<Step, "team" | "budget" | "finalize">;

export type Team =
  | { kind: "casting" }
  | { kind: "failed"; message: string }
  | { kind: "cast"; hires: HireProposal[] };

/** Where the founding stands: a team from its casting on, its hires once signed, and on the
 *  budget why main refused the last founding. */
export type Flow =
  | { step: Teamless }
  | { step: "team"; team: Team }
  | { step: "budget"; hires: HireProposal[]; failure: string | null }
  | { step: "finalize"; hires: HireProposal[] };

export const START: Flow = { step: "title" };

export type FlowEvent =
  /** Enter on a step, or its menu's forward choice, with what the move depends on. */
  | { kind: "next"; auth: Auth["phase"]; founderName: string; companyName: string }
  | { kind: "back" }
  /** A CLI signed in from the auth step. */
  | { kind: "signed-in" }
  /** "Search again". */
  | { kind: "recast" }
  | { kind: "cast"; hires: HireProposal[] }
  | { kind: "cast-failed"; message: string }
  /** "Rewrite the pitch". */
  | { kind: "rewrite" }
  | { kind: "found-failed"; message: string };

/** Where "back" goes, or null where it doesn't go anywhere. Only the cheap,
 *  reversible steps rewind: casting the team spends a real CLI call, and past
 *  that the office is on disk. */
export const BACK_STEP = {
  auth: null,
  biztype: "company",
  budget: null,
  company: "look",
  finalize: null,
  founder: null,
  intro: null,
  look: "founder",
  pitch: "biztype",
  team: null,
  title: null,
} satisfies Record<Step, Teamless | null>;

const CASTING: Flow = { step: "team", team: { kind: "casting" } };

const onward = (flow: Flow, e: Extract<FlowEvent, { kind: "next" }>): Flow => {
  switch (flow.step) {
    case "title": {
      return { step: "intro" };
    }
    case "intro": {
      // the CLI probe has to land first — routing before it would send a
      // signed-in founder to the login screen
      if (e.auth === "checking") {
        return flow;
      }
      return { step: e.auth === "signed-in" ? "founder" : "auth" };
    }
    case "founder": {
      return e.founderName.trim() ? { step: "look" } : flow;
    }
    case "look": {
      return { step: "company" };
    }
    case "company": {
      return e.companyName.trim() ? { step: "biztype" } : flow;
    }
    case "biztype": {
      return { step: "pitch" };
    }
    case "pitch": {
      return CASTING;
    }
    case "team": {
      return flow.team.kind === "cast"
        ? { failure: null, hires: flow.team.hires, step: "budget" }
        : flow;
    }
    case "budget": {
      return flow.hires.length > 0 ? { hires: flow.hires, step: "finalize" } : flow;
    }
    // the sign-in moves auth on, and the office opening is main's
    case "auth":
    case "finalize": {
      return flow;
    }
    // no default
  }
};

/** The founding after one event; an event its step does not take leaves it as it was. */
export const nextFlow = (flow: Flow, e: FlowEvent): Flow => {
  switch (e.kind) {
    case "next": {
      return onward(flow, e);
    }
    case "back": {
      const prev = BACK_STEP[flow.step];
      return prev === null ? flow : { step: prev };
    }
    case "signed-in": {
      return flow.step === "auth" ? { step: "founder" } : flow;
    }
    case "recast": {
      return flow.step === "team" && flow.team.kind !== "casting" ? CASTING : flow;
    }
    case "cast": {
      return flow.step === "team" && flow.team.kind === "casting"
        ? { step: "team", team: { hires: e.hires, kind: "cast" } }
        : flow;
    }
    case "cast-failed": {
      return flow.step === "team" && flow.team.kind === "casting"
        ? { step: "team", team: { kind: "failed", message: e.message } }
        : flow;
    }
    case "rewrite": {
      return flow.step === "team" && flow.team.kind === "failed" ? { step: "pitch" } : flow;
    }
    case "found-failed": {
      return flow.step === "finalize"
        ? { failure: e.message, hires: flow.hires, step: "budget" }
        : flow;
    }
    // no default
  }
};

/**
 * What the cursor and the script start over on: the step, and on the team step
 * the team, since a search again keeps the step and the new team's menu would
 * otherwise open on "Search again", one Enter from another paid search.
 */
export const sceneOf = (flow: Flow): string =>
  flow.step === "team" ? `team:${flow.team.kind}` : flow.step;

/** Why the step the founder is on was handed back to them: a casting or a founding that failed. */
export const failureOf = (flow: Flow): string | null => {
  if (flow.step === "budget") {
    return flow.failure;
  }
  return flow.step === "team" && flow.team.kind === "failed" ? flow.team.message : null;
};
