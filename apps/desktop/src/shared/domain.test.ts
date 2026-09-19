import { describe, expect, it } from "vitest";
import {
  BlockedAskSchema,
  parseBlockedAsk,
  resolveMentions,
  afterFailure,
  isRoutineDue,
  MAX_TASK_ATTEMPTS,
  serializeBlockedAsk,
} from "./domain";
import type { BlockedAsk } from "./domain";

describe("BlockedAsk round-trip through TASK.md", () => {
  it.each<BlockedAsk>([
    { question: "ship it?", type: "question" },
    { question: "why did [approve] show up here?", type: "question" },
    { integration: "vercel", reason: "need hosting", type: "integration" },
    { command: "npx vercel deploy --prod", rule: "deploy", type: "approval" },
  ])("%j", (ask) => {
    expect(parseBlockedAsk(serializeBlockedAsk(ask))).toEqual(ask);
  });

  it("reads an approval without a rule id as held by the broadest rule", () => {
    expect(parseBlockedAsk("[approve] git push origin main")).toEqual({
      command: "git push origin main",
      rule: "write-outside",
      type: "approval",
    });
  });

  it("preserves a retired rule through validation and TASK.md", () => {
    const saved = "[approve:retired-rule] git push origin main";
    const ask = BlockedAskSchema.parse(parseBlockedAsk(saved));
    expect(ask).toEqual({
      command: "git push origin main",
      rule: "retired-rule",
      type: "approval",
    });
    expect(serializeBlockedAsk(ask)).toBe(saved);
  });
});

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
