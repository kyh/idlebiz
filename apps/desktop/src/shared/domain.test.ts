import { describe, expect, it } from "vitest";
import {
  parseBlockedAsk,
  resolveMentions,
  afterFailure,
  MAX_TASK_ATTEMPTS,
  serializeBlockedAsk,
  type BlockedAsk,
} from "./domain";

describe("BlockedAsk round-trip through TASK.md", () => {
  it.each<BlockedAsk>([
    { type: "question", question: "ship it?" },
    { type: "question", question: "why did [approve] show up here?" },
    { type: "integration", integration: "vercel", reason: "need hosting" },
    { type: "approval", command: "npx vercel deploy --prod", rule: "deploy" },
  ])("%j", (ask) => {
    expect(parseBlockedAsk(serializeBlockedAsk(ask))).toEqual(ask);
  });

  it("reads an approval persisted before rules had ids by classifying the command today", () => {
    expect(parseBlockedAsk("[approve] git push origin main")).toEqual({
      type: "approval",
      command: "git push origin main",
      rule: "git-push",
    });
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
  it("backs off exponentially, capped, until the attempts are spent", () => {
    expect(afterFailure(0, 1000)).toEqual({ kind: "retry", attempts: 1, retryAt: 16_000 });
    expect(afterFailure(1, 1000)).toEqual({ kind: "retry", attempts: 2, retryAt: 31_000 });
    expect(afterFailure(MAX_TASK_ATTEMPTS - 1, 0)).toEqual({
      kind: "dead",
      attempts: MAX_TASK_ATTEMPTS,
    });
  });
});
