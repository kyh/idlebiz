import { RequestError } from "@agentclientprotocol/sdk";
import { liftsAt, limitOf } from "@repo/agent-driver/rate-limit";
import { describe, expect, it } from "vitest";

// noon in Los Angeles
const now = new Date("2026-09-23T19:00:00Z");
const minutes = (n: number): number => now.getTime() + n * 60_000;

describe("limitOf", () => {
  it("never reads the app's own text as a limit", () => {
    expect(limitOf(new Error("exceeded the 45m session limit — killed"), now)).toBeNull();
    expect(limitOf("You've hit your session limit", now)).toBeNull();
  });

  it("does not park on a rejection that names no limit", () => {
    expect(limitOf(RequestError.internalError({ errorKind: "server_error" }), now)).toBeNull();
    expect(limitOf(RequestError.internalError(undefined, "Session not found"), now)).toBeNull();
  });

  it("parks on claude's errorKind", () => {
    expect(limitOf(RequestError.internalError({ errorKind: "rate_limit" }), now)).toEqual({
      resetsAt: minutes(30),
    });
  });

  it("parks on claude's usage-limit text until the time it names in its zone", () => {
    const weekly = RequestError.internalError(
      undefined,
      "You've hit your weekly limit · resets 3pm (America/Los_Angeles)",
    );
    expect(limitOf(weekly, now)).toEqual({ resetsAt: minutes(180) });
  });

  it("caps a reset that lands absurdly far out", () => {
    const late = RequestError.internalError(
      undefined,
      "You're out of usage credits · try again in 30 hours",
    );
    expect(limitOf(late, now)).toEqual({ resetsAt: minutes(12 * 60) });
  });
});

describe("liftsAt", () => {
  it("is the time the agent's text names, else half an hour out", () => {
    expect(liftsAt("You've hit your usage limit. Try again in 2 hours 15 minutes.", now)).toBe(
      minutes(135),
    );
    expect(liftsAt("Server overloaded", now)).toBe(minutes(30));
  });

  it("reads the reset past an earlier 'in' that names no time", () => {
    expect(liftsAt("Please sign in to continue. Usage limit hit; try again in 2 hours.", now)).toBe(
      minutes(120),
    );
  });

  it("counts days toward the cap", () => {
    expect(liftsAt("Usage limit hit; try again in 3 days.", now)).toBe(minutes(12 * 60));
    expect(liftsAt("Usage limit hit; try again in 1 day 2 hours.", now)).toBe(minutes(12 * 60));
  });
});
