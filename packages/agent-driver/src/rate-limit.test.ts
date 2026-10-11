import { RequestError } from "@agentclientprotocol/sdk";
import {
  classOfRequestError,
  classOfText,
  classOfTypedFailure,
  liftsAt,
  rateLimitResetIn,
} from "./rate-limit";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_RATE_LIMIT_LIFTS_AT,
  CLAUDE_RATE_LIMITED_UPDATE,
} from "./claude-rate-limit.fixture";

// noon in Los Angeles
const now = new Date("2026-09-23T19:00:00Z");
const minutes = (n: number): number => now.getTime() + n * 60_000;

describe("classOfRequestError", () => {
  it("reads ACP's sign-in code and claude's refused logins as auth", () => {
    expect(classOfRequestError(RequestError.authRequired())).toBe("auth");
    for (const errorKind of ["authentication_failed", "oauth_org_not_allowed"]) {
      expect(classOfRequestError(RequestError.internalError({ errorKind }))).toBe("auth");
    }
  });

  it.each(["verification_required", "cloud_credential_error"])(
    "reads claude's %s as a refusal of access no sign-in repairs, as its adapter does",
    (errorKind) => {
      expect(classOfRequestError(RequestError.internalError({ errorKind }))).toBe("access-denied");
    },
  );

  it.each(["rate_limit", "billing_error", "account_on_hold"])(
    "reads claude's %s as a usage limit, never a sign-in",
    (errorKind) => {
      expect(classOfRequestError(RequestError.internalError({ errorKind }))).toBe("usage-limit");
    },
  );

  it("reads claude's overload as an overload, apart from a usage limit", () => {
    expect(
      classOfRequestError(RequestError.internalError({ errorKind: "overloaded" }, "Overloaded")),
    ).toBe("overloaded");
  });

  it("reads output past its room as the session's", () => {
    expect(
      classOfRequestError(RequestError.internalError({ errorKind: "max_output_tokens" })),
    ).toBe("context");
  });

  it("reads the agent's own text where its kind names nothing of the runner", () => {
    const weekly = RequestError.internalError(
      { errorKind: "unknown" },
      "You've hit your weekly limit · resets 3pm (America/Los_Angeles)",
    );
    expect(classOfRequestError(weekly)).toBe("usage-limit");
    expect(classOfRequestError(RequestError.internalError({ errorKind: "server_error" }))).toBe(
      "other",
    );
    expect(classOfRequestError(RequestError.internalError(undefined, "Session not found"))).toBe(
      "other",
    );
    // a kind this build does not know is no claim
    expect(
      classOfRequestError(RequestError.internalError({ errorKind: "brand_new" }, "Overloaded")),
    ).toBe("overloaded");
  });
});

const of = (category: string, actions: string[], text = "x") =>
  classOfTypedFailure({ actions, category, text });

describe("classOfTypedFailure", () => {
  it("reads codex's typed failures by category and actions", () => {
    expect(of("access", ["login"])).toBe("auth");
    expect(of("limit", [])).toBe("usage-limit");
    expect(of("limit", ["retry"])).toBe("usage-limit");
    expect(of("limit", ["new_session"])).toBe("context");
    expect(of("service", ["retry"], "Selected model is at capacity.")).toBe("overloaded");
    expect(of("service", ["retry"], "Turn failed")).toBe("other");
    expect(of("request", [], "Bad request")).toBe("other");
  });
});

describe("classOfText", () => {
  it("tells an overload from a usage limit", () => {
    expect(classOfText("overloaded_error")).toBe("overloaded");
    expect(classOfText("You've hit your usage limit")).toBe("usage-limit");
    expect(classOfText("Turn failed")).toBe("other");
  });
});

describe("rateLimitResetIn", () => {
  const { _meta } = CLAUDE_RATE_LIMITED_UPDATE.params.update;
  const info = _meta["_claude/rateLimit"];

  it("is when claude's refused limit lifts, its epoch seconds read off the update its adapter sends", () => {
    expect(rateLimitResetIn(_meta)).toBe(CLAUDE_RATE_LIMIT_LIFTS_AT);
  });

  it("is null once it allows requests, and says nothing of an update naming no reset", () => {
    for (const status of ["allowed", "allowed_warning"]) {
      expect(rateLimitResetIn({ ..._meta, "_claude/rateLimit": { ...info, status } })).toBeNull();
    }
    // still refused with no reset named: a reset an earlier update named must stand
    expect(rateLimitResetIn({ "_claude/rateLimit": { status: "rejected" } })).toBeUndefined();
    expect(rateLimitResetIn(null)).toBeUndefined();
    expect(rateLimitResetIn({ other: true })).toBeUndefined();
  });
});

describe("liftsAt", () => {
  it("is the reset the provider reported while it is ahead, over what the text names", () => {
    expect(liftsAt("Try again in 2 hours", minutes(45), now)).toBe(minutes(45));
    expect(liftsAt("Try again in 2 hours", minutes(-5), now)).toBe(minutes(120));
    expect(liftsAt("Usage limit", minutes(3 * 24 * 60), now)).toBe(minutes(3 * 24 * 60));
  });

  it("is the time the agent's text names, else none", () => {
    expect(
      liftsAt("You've hit your usage limit. Try again in 2 hours 15 minutes.", null, now),
    ).toBe(minutes(135));
    expect(liftsAt("Usage limit reached", null, now)).toBeNull();
    expect(liftsAt("Usage limit reached", minutes(-5), now)).toBeNull();
  });

  it("reads a reset at a wall-clock time in its zone", () => {
    expect(
      liftsAt("You've hit your weekly limit · resets 3pm (America/Los_Angeles)", null, now),
    ).toBe(minutes(180));
  });

  it("reads the reset past an earlier 'in' that names no time", () => {
    expect(
      liftsAt("Please sign in to continue. Usage limit hit; try again in 2 hours.", null, now),
    ).toBe(minutes(120));
  });

  it("counts days", () => {
    expect(liftsAt("Usage limit hit; try again in 3 days.", null, now)).toBe(minutes(3 * 24 * 60));
    expect(liftsAt("Usage limit hit; try again in 1 day 2 hours.", null, now)).toBe(
      minutes(26 * 60),
    );
    expect(liftsAt("You're out of usage credits · try again in 30 hours", null, now)).toBe(
      minutes(30 * 60),
    );
  });
});
