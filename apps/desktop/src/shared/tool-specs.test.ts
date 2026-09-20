import { describe, expect, it } from "vitest";
import { TOOL_NAMES, TOOL_SPECS, toolDocs } from "./tool-specs";

describe("tool specs", () => {
  it.each(TOOL_NAMES)("%s teaches a request its own body accepts", (name) => {
    const spec = TOOL_SPECS[name];
    expect(spec.body.safeParse(spec.example).success).toBe(true);
  });

  it("serves every tool on a route of its own", () => {
    const routes = TOOL_NAMES.map((n) => `${TOOL_SPECS[n].method} ${TOOL_SPECS[n].path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("shows the lead's tools to the lead alone", () => {
    expect(toolDocs(false)).not.toContain("**open_bet**");
    expect(toolDocs(false)).toContain("**delegate**");
    expect(toolDocs(true)).toContain("**open_bet**");
  });

  it("renders the call an agent can paste", () => {
    expect(toolDocs(false)).toContain(
      `curl -s -X POST "$IDLEBIZ_API_URL/v1/ask-boss" -H "Authorization: Bearer $IDLEBIZ_RUN_TOKEN" -H "content-type: application/json" -d '{"question":"..."}'`,
    );
    expect(toolDocs(false)).toContain(
      `curl -s "$IDLEBIZ_API_URL/v1/team-chat" -H "Authorization: Bearer $IDLEBIZ_RUN_TOKEN"`,
    );
  });
});
