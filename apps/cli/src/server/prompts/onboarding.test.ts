import { describe, expect, it } from "vitest";
import { foundingTeamPrompt } from "./onboarding";

describe("foundingTeamPrompt", () => {
  it("casts for the founder's pitch when there is one", () => {
    const text = foundingTeamPrompt("Acme", "a cozy farming roguelike", "game-studio");
    expect(text).toContain("Pitch: a cozy farming roguelike");
    expect(text).toContain("tailored to THIS pitch");
    expect(text).toContain("Business type: Game studio.");
  });

  it("casts for the business type alone when the founder left the pick to the team", () => {
    const text = foundingTeamPrompt("Acme", null, "software");
    expect(text).toContain("Pitch: none. The founder left what to build to the team");
    expect(text).toContain("tailored to THIS business");
    expect(text).toContain("Business type: Software company.");
    expect(text).not.toContain("null");
  });
});
