import { describe, expect, it } from "vitest";
import type { LoadSkip } from "@/shared/domain";
import { bootOf } from "./boot";

const known = { authed: true, booted: true, hasCompany: true, saveIssues: [] };

const skip = (kind: LoadSkip["kind"]): LoadSkip => ({ error: "bad yaml", kind, path: `/${kind}` });

describe("bootOf", () => {
  it("stops at an unreadable company before anything else", () => {
    expect(
      bootOf({ ...known, authed: null, booted: false, saveIssues: [skip("company")] }),
    ).toEqual({ issues: [skip("company")], kind: "unreadable" });
  });

  it("opens the office past a skipped package that is not the company", () => {
    expect(bootOf({ ...known, saveIssues: [skip("task")] })).toEqual({ kind: "office" });
  });

  it("shows nothing until the first refresh lands", () => {
    expect(bootOf({ ...known, booted: false })).toEqual({ kind: "loading" });
  });

  it("onboards without waiting on the CLI probe", () => {
    expect(bootOf({ ...known, authed: null, hasCompany: false })).toEqual({ kind: "onboarding" });
  });

  it("holds the office until the CLI probe answers", () => {
    expect(bootOf({ ...known, authed: null })).toEqual({ kind: "loading" });
  });

  it("gates a company on a signed-in CLI", () => {
    expect(bootOf({ ...known, authed: false })).toEqual({ kind: "signed-out" });
    expect(bootOf(known)).toEqual({ kind: "office" });
  });
});
