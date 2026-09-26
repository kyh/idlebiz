import { describe, expect, it } from "vitest";
import { TOOL_NAMES, TOOL_SPECS, toolDocs } from "./tool-specs";

describe("tool specs", () => {
  it.each(TOOL_NAMES)("%s teaches a request its own body accepts", (name) => {
    const spec = TOOL_SPECS[name];
    expect(spec.body.safeParse(spec.example).success).toBe(true);
  });

  it.each(TOOL_NAMES)("%s refuses a key it does not know", (name) => {
    const spec = TOOL_SPECS[name];
    expect(spec.body.safeParse({ ...spec.example, extra: 1 }).success).toBe(false);
  });

  it("gives only a users bet a landing path", () => {
    const { body, example } = TOOL_SPECS.open_bet;
    const landing = { ...example, landingPath: "/guides" };
    expect(body.safeParse(landing).success).toBe(true);
    expect(body.safeParse({ ...landing, metric: "revenue" }).success).toBe(false);
    expect(body.safeParse({ ...example, metric: "revenue" }).success).toBe(true);
  });

  it.each([
    ["users", 1, "at least 10"],
    ["users", 9, "at least 10"],
    ["users", 10.5, "whole number"],
    ["revenue", 1, "at least $5.00"],
    ["revenue", 4.99, "at least $5.00"],
  ])("refuses a %s target of %d, naming the floor", (metric, target, floor) => {
    const { body, example } = TOOL_SPECS.open_bet;
    const parsed = body.safeParse({ ...example, metric, target });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain(floor);
  });

  it.each([
    ["users", 10],
    ["revenue", 5],
    ["revenue", 12.5],
  ])("takes a %s target of %d", (metric, target) => {
    const { body, example } = TOOL_SPECS.open_bet;
    expect(body.safeParse({ ...example, metric, target }).success).toBe(true);
  });

  it.each([0.49, 10_000.01])("refuses a payment link of $%d", (amountUsd) => {
    const { body, example } = TOOL_SPECS.create_payment_link;
    expect(body.safeParse({ ...example, amountUsd }).success).toBe(false);
  });

  it.each([
    [{ question: "Monthly or yearly?" }, true],
    [{ action: "Buy acme.dev", instructions: "Any registrar; send me the account email." }, true],
    [{ action: "Buy acme.dev", draft: "", instructions: "..." }, true],
    [{ action: "Buy acme.dev", draft: null, instructions: "..." }, true],
    [{ action: "Buy acme.dev" }, false],
    [{ action: "Buy acme.dev", instructions: "...", question: "Or not?" }, false],
  ])("takes %j as an ask: %s", (body, ok) => {
    expect(TOOL_SPECS.ask_boss.body.safeParse(body).success).toBe(ok);
  });

  it.each([{}, { action: "Buy acme.dev" }, { action: "Buy", draft: 3, instructions: "..." }])(
    "answers %j with the two shapes an ask takes",
    (body) => {
      const parsed = TOOL_SPECS.ask_boss.body.safeParse(body);
      expect(parsed.error?.issues[0]?.message).toContain('{"action":"...","instructions":"..."}');
    },
  );

  it.each([
    ["OPENAI_API_KEY", true],
    ["_PRIVATE", true],
    ["openai_key", false],
    ["2FA_SECRET", false],
    ["OPENAI-KEY", false],
    ["VERCEL_URL", false],
    ["NOW_REGION", false],
    ["NODE_ENV", false],
    ["TZ", false],
    ["NEXT_PUBLIC_STRIPE_KEY", false],
    ["VITE_API_KEY", false],
  ])("takes %s as a variable to set: %s", (name, ok) => {
    const { body, example } = TOOL_SPECS.set_env;
    expect(body.safeParse({ ...example, name }).success).toBe(ok);
  });

  it("tells an agent why a name the page would show is refused", () => {
    const { body, example } = TOOL_SPECS.set_env;
    const parsed = body.safeParse({ ...example, name: "NEXT_PUBLIC_STRIPE_KEY" });
    expect(parsed.error?.issues[0]?.message).toContain("where every visitor reads it");
  });

  it("tells the lead each metric's floor", () => {
    expect(toolDocs(true)).toContain("at least 10 users, a whole number, or $5.00");
  });

  it("serves every tool on a route of its own", () => {
    const routes = TOOL_NAMES.map((n) => `${TOOL_SPECS[n].method} ${TOOL_SPECS[n].path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("shows the lead's tools to the lead alone", () => {
    expect(toolDocs(false)).not.toContain("**open_bet**");
    expect(toolDocs(false)).toContain("**delegate**");
    expect(toolDocs(false)).toContain("**deploy**");
    expect(toolDocs(false)).toContain("**create_payment_link**");
    expect(toolDocs(true)).toContain("**open_bet**");
  });

  it("renders the call an agent can paste", () => {
    expect(toolDocs(false)).toContain(
      `curl -s -X POST "$IDLEBIZ_API_URL/v1/ask-boss" -H "Authorization: Bearer $IDLEBIZ_RUN_TOKEN" -H "content-type: application/json" -d '{"action":"Post the launch thread on r/SideProject","draft":"...","instructions":"..."}'`,
    );
    expect(toolDocs(false)).toContain(
      `curl -s "$IDLEBIZ_API_URL/v1/team-chat" -H "Authorization: Bearer $IDLEBIZ_RUN_TOKEN"`,
    );
  });
});
