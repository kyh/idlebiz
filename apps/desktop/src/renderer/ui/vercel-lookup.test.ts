import { describe, expect, it } from "vitest";
import type { VercelListing, VercelProject } from "@/shared/integrations";
import { lookupFor, problemOf } from "./vercel-lookup";

const project: VercelProject = { id: "prj_1", name: "acme" };
const listed: VercelListing = { account: "kai", kind: "loaded", projects: [project] };

describe("the Vercel picker's lookup", () => {
  it("shows a fault reading the saved token instead of asking for a paste", () => {
    const lookup = lookupFor({ kind: "failed", message: "IPC closed" });
    expect(lookup).toEqual({ message: "IPC closed", state: "error" });
    expect(problemOf(lookup)).toBe("IPC closed");
  });

  it("asks for a paste when the saved token is refused or missing", () => {
    expect(lookupFor({ current: true, kind: "ready", value: { kind: "rejected" } })).toEqual({
      state: "idle",
    });
  });

  it("says a pasted token was rejected", () => {
    const lookup = lookupFor(
      { current: true, kind: "ready", value: { kind: "rejected" } },
      "vercel_x",
    );
    expect(problemOf(lookup)).toMatch(/rejected/u);
  });

  it("is still checking while the listing on screen is for an older token", () => {
    expect(lookupFor({ current: false, kind: "ready", value: listed }, "vercel_x")).toEqual({
      state: "loading",
    });
  });

  it("remembers which token listed the projects", () => {
    expect(lookupFor({ current: true, kind: "ready", value: listed }, "vercel_x")).toEqual({
      account: "kai",
      projects: [project],
      state: "loaded",
      token: "vercel_x",
    });
  });
});
