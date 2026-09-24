import { describe, expect, it } from "vitest";
import { describeRule } from "./hold-rules";

describe("describeRule", () => {
  it("describes current rules and identifies unavailable saved rules", () => {
    expect(describeRule("git-push")).toBe("Push commits to a remote repository.");
    expect(describeRule("browser-unseen")).toContain("one run of exactly this command");
    expect(describeRule("sandbox-widen")).toContain("until the run ends");
    expect(describeRule("save-edit")).toContain("save files");
    expect(describeRule("unknown-ask")).toContain("one run of exactly this");
    expect(describeRule("retired-rule")).toBe(
      'Saved rule "retired-rule" is unavailable in this version.',
    );
  });
});
