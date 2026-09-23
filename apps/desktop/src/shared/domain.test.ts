import { describe, expect, it } from "vitest";
import {
  resolveMentions,
  afterFailure,
  entering,
  isRoutineDue,
  leadOf,
  MAX_AGENTS,
  MAX_TASK_ATTEMPTS,
  MaxAgentsSchema,
} from "./domain";

describe("resolveMentions", () => {
  const roster = [
    { id: "sam-okafor", name: "Sam Okafor" },
    { id: "samantha-cruz", name: "Samantha Cruz" },
    { id: "lee", name: "Lee Park" },
  ];

  it("matches a slug, then a whole first name, never a prefix", () => {
    expect(resolveMentions("@sam-okafor ship it", roster)).toEqual(["sam-okafor"]);
    expect(resolveMentions("@sam, thoughts?", roster)).toEqual(["sam-okafor"]);
    expect(resolveMentions("@Samantha and @lee", roster)).toEqual(["samantha-cruz", "lee"]);
    expect(resolveMentions("email me@example.com", roster)).toEqual([]);
  });
});

describe("afterFailure", () => {
  it("backs off exponentially until the attempts are spent", () => {
    expect(afterFailure(0, 1000)).toEqual({ attempts: 1, kind: "retry", retryAt: 16_000 });
    expect(afterFailure(1, 1000)).toEqual({ attempts: 2, kind: "retry", retryAt: 31_000 });
    expect(afterFailure(MAX_TASK_ATTEMPTS - 1, 0)).toEqual({
      attempts: MAX_TASK_ATTEMPTS,
      kind: "dead",
    });
  });
});

describe("isRoutineDue", () => {
  const routine = {
    companyId: "co",
    id: "playtest",
    instruction: "play it",
    intervalHours: 24,
    lastRunAt: null,
    name: "Playtest",
    role: null,
  };
  const DAY = 86_400_000;

  it("waits out the first interval from the founding", () => {
    expect(isRoutineDue(routine, 1000, 1000)).toBe(false);
    expect(isRoutineDue(routine, 1000, 1000 + DAY)).toBe(true);
  });

  it("counts from the last run once there is one", () => {
    expect(isRoutineDue({ ...routine, lastRunAt: DAY }, 0, DAY + 1)).toBe(false);
    expect(isRoutineDue({ ...routine, lastRunAt: DAY }, 0, 2 * DAY)).toBe(true);
  });
});

describe("leadOf", () => {
  it("is the first hire, whatever anyone's title says", () => {
    expect(leadOf([{ id: "ngozi" }, { id: "mirae" }, { id: "desmond" }])).toBe("ngozi");
  });

  it("has nobody to pick from an empty roster", () => {
    expect(leadOf([])).toBeNull();
  });
});

describe("entering", () => {
  it("stamps a run's start and the moment it settled, and nothing else", () => {
    expect(entering({ kind: "running", runId: "r" }, 5)).toMatchObject({ startedAt: 5 });
    expect(entering({ kind: "done", summary: null }, 7)).toMatchObject({ completedAt: 7 });
    expect(entering({ kind: "dead", lastError: "x" }, 8)).toMatchObject({ completedAt: 8 });
    expect(entering({ kind: "todo" }, 9)).toEqual({ state: { kind: "todo" } });
  });
});

describe("MaxAgentsSchema", () => {
  it.each(["1", "12", String(MAX_AGENTS)])("takes %j from the settings field", (typed) => {
    expect(MaxAgentsSchema.safeParse(Number(typed)).success).toBe(true);
  });

  it.each(["", "0", "2.5", "twelve", String(MAX_AGENTS + 1)])("refuses %j", (typed) => {
    expect(MaxAgentsSchema.safeParse(Number(typed)).success).toBe(false);
  });
});
