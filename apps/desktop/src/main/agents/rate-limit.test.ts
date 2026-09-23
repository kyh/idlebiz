import { RequestError } from "@agentclientprotocol/sdk";
import { limitOf } from "@repo/agent-driver/rate-limit";
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

  it("parks on codex's usage limit, though its message says only Internal error", () => {
    const bare = new RequestError(-32_603, "Internal error", {
      codexErrorInfo: "usageLimitExceeded",
    });
    expect(limitOf(bare, now)).toEqual({ resetsAt: minutes(30) });

    const told = RequestError.internalError({
      codexErrorInfo: "usageLimitExceeded",
      message: "You've hit your usage limit. Try again in 2 hours 15 minutes.",
    });
    expect(limitOf(told, now)).toEqual({ resetsAt: minutes(135) });
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
