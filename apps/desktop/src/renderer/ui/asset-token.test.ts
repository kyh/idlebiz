import { describe, expect, it } from "vitest";
import { ASSET_TOKEN, relFromToken } from "./asset-token";

const relsIn = (text: string): string[] =>
  [...text.matchAll(ASSET_TOKEN)].map(([token]) => relFromToken(token));

describe("a file path in agent text", () => {
  it.each([
    ["see /Users/x/.idlebiz/acme/shared/plan.md for it", "plan.md"],
    ["see /Users/x/.idlebiz/acme/workspace/docs/spec.md for it", "docs/spec.md"],
    ["see /Users/x/.idlebiz/acme/products/next/workspace/index.html for it", "index.html"],
    ["see notes.md for it", "notes.md"],
    ["see docs/spec.md for it", "docs/spec.md"],
    ["see src/shared/domain.ts for it", "src/shared/domain.ts"],
    ["see components/workspace/a.tsx for it", "components/workspace/a.tsx"],
  ])("opens the path in %j as %j", (text, rel) => {
    expect(relsIn(text)).toEqual([rel]);
  });

  it.each([
    ["Deployed to https://acme.vercel.app, go look", "https://acme.vercel.app"],
    ["Pay here: https://buy.stripe.com/abc123.", "https://buy.stripe.com/abc123"],
    ["**https://acme.vercel.app**", "https://acme.vercel.app"],
    ["is it live (https://acme.vercel.app/pricing?)", "https://acme.vercel.app/pricing"],
    ["see /Users/x/.idlebiz/acme/workspace/docs/spec.md.", "docs/spec.md"],
  ])("leaves the sentence's punctuation off the link in %j", (text, rel) => {
    expect(relsIn(text)).toEqual([rel]);
  });

  it("leaves prose that only looks like a file as text", () => {
    expect(relsIn("built on Node.js")).toEqual([]);
  });
});
