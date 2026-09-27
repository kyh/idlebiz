import { describe, expect, it } from "vitest";
import type { BlockedAsk } from "@/shared/domain";
import type { VercelListing, VercelProject } from "@/shared/integrations";
import { awaitsVercelToken, lookupFor, problemOf } from "./vercel-lookup";

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

const waiting = (productId: string | null, ask: BlockedAsk) => ({
  productId,
  state: { ask },
});

describe("a product bound to Vercel", () => {
  const VERCEL: BlockedAsk = {
    integration: "vercel",
    reason: "Vercel turned IdleBiz's token away while checking Acme's domains",
    type: "integration",
  };

  it("takes a new token while the team waits on Vercel for it, or for no product named", () => {
    expect(awaitsVercelToken("acme", [waiting("acme", VERCEL)])).toBe(true);
    expect(awaitsVercelToken("acme", [waiting(null, VERCEL)])).toBe(true);
  });

  it("only shows its binding while nobody waits on Vercel for it", () => {
    expect(awaitsVercelToken("acme", [])).toBe(false);
    expect(awaitsVercelToken("acme", [waiting("side", VERCEL)])).toBe(false);
    expect(
      awaitsVercelToken("acme", [
        waiting("acme", { integration: "stripe", reason: "to count revenue", type: "integration" }),
        waiting("acme", { question: "Ship it?", type: "question" }),
      ]),
    ).toBe(false);
  });
});
