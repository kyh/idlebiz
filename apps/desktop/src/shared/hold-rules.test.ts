import { describe, expect, it } from "vitest";
import { approvalScope, describeRule } from "./hold-rules";

describe("describeRule", () => {
  it("describes current rules and identifies unavailable saved rules", () => {
    expect(describeRule("git-push")).toBe("Push commits to a remote repository.");
    expect(describeRule("browser-unseen")).toContain("one run of exactly this command");
    expect(describeRule("unknown-ask")).toContain("one run of exactly this");
    expect(describeRule("save-edit")).toBe(
      'Saved rule "save-edit" is unavailable in this version.',
    );
    expect(describeRule("retired-rule")).toBe(
      'Saved rule "retired-rule" is unavailable in this version.',
    );
  });

  it("says a leased approval covers the rest of the run, and any other one run", () => {
    expect(approvalScope("browser-act")).toContain("rest of this run");
    expect(approvalScope("external-tool")).toContain("rest of this run");
    expect(approvalScope("git-push")).toContain("once");
    expect(approvalScope("unknown-ask")).toContain("once");
    expect(approvalScope("retired-rule")).toContain("once");
  });
});
