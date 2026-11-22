import { unreachable } from "@repo/domain/errors";
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
  | { kind: "next"; auth: Auth["phase"]; founderName: string; companyName: string }
  | { kind: "back" }
  | { kind: "signed-in" }
  | { kind: "recast" }
  | { kind: "cast"; hires: HireProposal[] }
  | { kind: "cast-failed"; message: string }
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

const onward = (flow: Flow, e: Extract<FlowEvent, { kind: "next" }>) => {
  switch (flow.step) {
    case "title": {
      return { step: "intro" } satisfies Flow;
    }

    case "intro": {
      if (e.auth === "checking") {
        return flow;
      }

      return { step: e.auth === "signed-in" ? "founder" : "auth" } satisfies Flow;
    }

    case "founder": {
      return (e.founderName.trim() ? { step: "look" } : flow) satisfies Flow;
    }

    case "look": {
      return { step: "company" } satisfies Flow;
    }

    case "company": {
      return (e.companyName.trim() ? { step: "biztype" } : flow) satisfies Flow;
    }

    case "biztype": {
      return { step: "pitch" } satisfies Flow;
    }

    case "pitch": {
      return CASTING;
    }

    case "team": {
      return (
        flow.team.kind === "cast" ? { failure: null, hires: flow.team.hires, step: "budget" } : flow
      ) satisfies Flow;
    }

    case "budget": {
      return (
        flow.hires.length > 0 ? { hires: flow.hires, step: "finalize" } : flow
      ) satisfies Flow;
    }

    case "auth":
    case "finalize": {
      return flow;
    }

    default: {
      return unreachable(flow);
    }
  }
};

/** The founding after one event; an event its step does not take leaves it as it was. */
export const nextFlow = (flow: Flow, e: FlowEvent) => {
  switch (e.kind) {
    case "next": {
      return onward(flow, e);
    }

    case "back": {
      const prev = BACK_STEP[flow.step];

      return (prev === null ? flow : { step: prev }) satisfies Flow;
    }

    case "signed-in": {
      return (flow.step === "auth" ? { step: "founder" } : flow) satisfies Flow;
    }

    case "recast": {
      return flow.step === "team" && flow.team.kind !== "casting" ? CASTING : flow;
    }

    case "cast": {
      return (
        flow.step === "team" && flow.team.kind === "casting"
          ? { step: "team", team: { hires: e.hires, kind: "cast" } }
          : flow
      ) satisfies Flow;
    }

    case "cast-failed": {
      return (
        flow.step === "team" && flow.team.kind === "casting"
          ? { step: "team", team: { kind: "failed", message: e.message } }
          : flow
      ) satisfies Flow;
    }

    case "rewrite": {
      return (
        flow.step === "team" && flow.team.kind === "failed" ? { step: "pitch" } : flow
      ) satisfies Flow;
    }

    case "found-failed": {
      return (
        flow.step === "finalize" ? { failure: e.message, hires: flow.hires, step: "budget" } : flow
      ) satisfies Flow;
    }

    default: {
      return unreachable(e);
    }
  }
};

/**
 * What the cursor and the script start over on: the step, and on the team step
 * the team, since a search again keeps the step and the new team's menu would
 * otherwise open on "Search again", one Enter from another paid search.
 */
export const sceneOf = (flow: Flow) =>
  flow.step === "team" ? `team:${flow.team.kind}` : flow.step;

/** Why the step the founder is on was handed back to them: a casting or a founding that failed. */
export const failureOf = (flow: Flow) => {
  if (flow.step === "budget") {
    return flow.failure;
  }

  return flow.step === "team" && flow.team.kind === "failed" ? flow.team.message : null;
};
