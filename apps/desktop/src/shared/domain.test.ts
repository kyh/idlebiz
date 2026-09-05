import { describe, expect, it } from "vitest";
import {
  parseBlockedAsk,
  resolveMentions,
  retryDelayMs,
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

describe("retryDelayMs", () => {
  it("backs off exponentially and caps", () => {
    expect(retryDelayMs(1)).toBe(15_000);
    expect(retryDelayMs(2)).toBe(30_000);
    expect(retryDelayMs(10)).toBe(10 * 60_000);
  });
});
