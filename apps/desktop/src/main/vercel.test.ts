import { describe, expect, it } from "vitest";
import { visitQuery } from "./vercel";

const project = { projectId: "prj_1", teamId: "team_1" };

describe("visitQuery", () => {
  it("asks for every visit when given no window", () => {
    expect(visitQuery({ projectId: "prj_1", teamId: null }, {}, 0)).toEqual({ projectId: "prj_1" });
  });

  it("never sends since without until: the API refuses one without the other", () => {
    const query = visitQuery(project, { since: 0 }, 86_400_000);
    expect(query).toMatchObject({
      since: "1970-01-01T00:00:00.000Z",
      teamId: "team_1",
      until: "1970-01-02T00:00:00.000Z",
    });
  });

  it("counts a path and what is under it, not its lookalike neighbours", () => {
    expect(visitQuery(project, { under: "/b/launch" }, 0).filter).toBe(
      "requestPath eq '/b/launch' or startswith(requestPath, '/b/launch/')",
    );
    expect(visitQuery(project, { under: "/guides/" }, 0).filter).toBe(
      "requestPath eq '/guides/' or startswith(requestPath, '/guides/')",
    );
  });
});
