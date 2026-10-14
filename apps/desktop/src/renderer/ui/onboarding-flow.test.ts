import { describe, expect, it } from "vitest";
import type { HireProposal } from "@repo/domain/hire";
import { START, failureOf, nextFlow, sceneOf } from "./onboarding-flow";
import type { Flow, FlowEvent } from "./onboarding-flow";

const hires: HireProposal[] = [
  {
    blurb: "Ships the first build",
    name: "Priya",
    persona: "Builds what the pitch needs first.",
    role: "engineer",
    spriteSeed: "priya",
    title: "Engineer",
  },
];

type Next = Extract<FlowEvent, { kind: "next" }>;
const forward = (auth: Next["auth"] = "signed-in"): Next => ({
  auth,
  companyName: "Acme AI",
  founderName: "Ada",
  kind: "next",
});

const replay = (events: FlowEvent[]): Flow => {
  let flow = START;
  for (const e of events) {
    flow = nextFlow(flow, e);
  }
  return flow;
};

const castFlow: Flow = { step: "team", team: { hires, kind: "cast" } };
const failedFlow: Flow = { step: "team", team: { kind: "failed", message: "no recruiter" } };

describe("the founding flow", () => {
  it("walks a signed-in founder from the title to the founding", () => {
    const founding = replay([
      forward(),
      forward(),
      forward(),
      forward(),
      forward(),
      forward(),
      forward(),
      { hires, kind: "cast" },
      forward(),
      forward(),
    ]);
    expect(founding).toEqual({ hires, step: "finalize" });
  });

  it("waits on the intro while the CLI is still being checked", () => {
    const intro = replay([forward()]);
    expect(nextFlow(intro, forward("checking"))).toBe(intro);
    expect(nextFlow(intro, forward("signed-out"))).toEqual({ step: "auth" });
    expect(nextFlow(intro, forward("signed-in"))).toEqual({ step: "founder" });
  });

  it("moves the auth step on only once a CLI signs in", () => {
    const auth: Flow = { step: "auth" };
    expect(nextFlow(auth, forward("signed-out"))).toBe(auth);
    expect(nextFlow(auth, { kind: "signed-in" })).toEqual({ step: "founder" });
  });

  it("holds a name step until something is typed", () => {
    const founder: Flow = { step: "founder" };
    expect(nextFlow(founder, { ...forward(), founderName: "  " })).toBe(founder);
    const company: Flow = { step: "company" };
    expect(nextFlow(company, { ...forward(), companyName: "" })).toBe(company);
  });

  it("refuses back on the team, the budget and the founding", () => {
    const steps: Flow[] = [
      { step: "team", team: { kind: "casting" } },
      castFlow,
      failedFlow,
      { failure: null, hires, step: "budget" },
      { hires, step: "finalize" },
    ];
    for (const flow of steps) {
      expect(nextFlow(flow, { kind: "back" })).toBe(flow);
    }
    expect(nextFlow({ step: "pitch" }, { kind: "back" })).toEqual({ step: "biztype" });
  });

  it("clears the team and goes back to the pitch on a rewrite", () => {
    expect(nextFlow(failedFlow, { kind: "rewrite" })).toEqual({ step: "pitch" });
  });

  it("casts again on a search again, from a cast team or a failed one", () => {
    for (const flow of [castFlow, failedFlow]) {
      expect(nextFlow(flow, { kind: "recast" })).toEqual({
        step: "team",
        team: { kind: "casting" },
      });
    }
  });

  it("lands a casting's result only while it is casting", () => {
    const casting: Flow = { step: "team", team: { kind: "casting" } };
    expect(nextFlow(casting, { kind: "cast-failed", message: "busy" })).toEqual({
      step: "team",
      team: { kind: "failed", message: "busy" },
    });
    expect(nextFlow(castFlow, { hires: [], kind: "cast" })).toBe(castFlow);
  });

  it("founds only with somebody to found it with", () => {
    const empty: Flow = { failure: null, hires: [], step: "budget" };
    expect(nextFlow(empty, forward())).toBe(empty);
  });

  it("returns a refused founding to the budget with main's reason", () => {
    const refused = nextFlow({ hires, step: "finalize" }, { kind: "found-failed", message: "no" });
    expect(refused).toEqual({ failure: "no", hires, step: "budget" });
    expect(failureOf(refused)).toBe("no");
    expect(failureOf(nextFlow(refused, forward()))).toBeNull();
  });

  it("starts the cursor over when a search again recasts the team", () => {
    const recast = nextFlow(castFlow, { kind: "recast" });
    expect(sceneOf(recast)).not.toBe(sceneOf(castFlow));
    expect(sceneOf(nextFlow(recast, { hires, kind: "cast" }))).toBe(sceneOf(castFlow));
  });
});
