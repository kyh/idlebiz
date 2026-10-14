import { describe, expect, it, vi } from "vitest";
import { tempSave } from "./test-support/save";
import { latestDeployment, productionHosts, visitQuery, webAnalyticsVisitors } from "./vercel";

tempSave();

const project = { projectId: "prj_1", projectName: "acme", teamId: "team_1" };
const ownProject = (projectId: string) => ({ projectId, projectName: "acme", teamId: null });

describe("visitQuery", () => {
  it("asks for every visit when given no window", () => {
    expect(visitQuery({ projectId: "prj_1" }, {})).toEqual({ projectId: "prj_1" });
  });

  it("sends since and until together: the API refuses one without the other", () => {
    const query = visitQuery(project, { span: { since: 0, until: 86_400_000 } });
    expect(query).toMatchObject({
      since: "1970-01-01T00:00:00.000Z",
      until: "1970-01-02T00:00:00.000Z",
    });
  });

  it("counts a path and what is under it, not its lookalike neighbours", () => {
    expect(visitQuery(project, { under: "/b/launch" }).filter).toBe(
      "requestPath eq '/b/launch' or startswith(requestPath, '/b/launch/')",
    );
    expect(visitQuery(project, { under: "/guides/" }).filter).toBe(
      "requestPath eq '/guides/' or startswith(requestPath, '/guides/')",
    );
  });
});

/** Answer every Vercel call with `answer`, and count the calls. */
const vercel = (answer: () => Promise<Response>) => {
  const seen = { calls: 0 };
  vi.stubGlobal("fetch", () => {
    seen.calls += 1;
    return answer();
  });
  return seen;
};
const status = (code: number) => () => Promise.resolve(new Response("{}", { status: code }));

describe("webAnalyticsVisitors", () => {
  it("counts the project's visitors in its team, as the founder", async () => {
    const asked: { url: URL; auth: string | null }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      asked.push({ auth: new Headers(init?.headers).get("authorization"), url: new URL(url) });
      return Promise.resolve(Response.json({ data: { visitors: 7 } }));
    });

    await expect(webAnalyticsVisitors(project, "tok", { under: "/b/launch" })).resolves.toBe(7);
    expect(asked.map(({ auth, url }) => [auth, Object.fromEntries(url.searchParams)])).toEqual([
      [
        "Bearer tok",
        {
          filter: "requestPath eq '/b/launch' or startswith(requestPath, '/b/launch/')",
          projectId: "prj_1",
          teamId: "team_1",
        },
      ],
    ]);
  });
});

describe("latestDeployment", () => {
  it("reads the latest production deploy", async () => {
    vercel(() =>
      Promise.resolve(
        Response.json({
          deployments: [{ createdAt: 5, readyState: "READY", url: "acme.vercel.app" }],
        }),
      ),
    );

    await expect(latestDeployment(ownProject("prj_live"), "saved-token")).resolves.toEqual({
      deployment: { createdAt: 5, state: "READY", url: "https://acme.vercel.app" },
      kind: "deployed",
    });
  });

  it("tells a refused token apart from nothing deployed", async () => {
    vercel(status(401));
    await expect(latestDeployment(ownProject("prj_revoked"), "saved-token")).resolves.toEqual({
      kind: "refused",
    });

    vercel(status(403));
    await expect(
      latestDeployment({ ...project, projectId: "prj_other_team" }, "saved-token"),
    ).resolves.toEqual({
      kind: "refused",
    });
  });

  it("reads an outage or an empty project as nothing deployed", async () => {
    vercel(status(500));
    await expect(latestDeployment(ownProject("prj_down"), "saved-token")).resolves.toEqual({
      kind: "none",
    });

    vercel(() => Promise.reject(new TypeError("fetch failed")));
    await expect(latestDeployment(ownProject("prj_offline"), "saved-token")).resolves.toEqual({
      kind: "none",
    });

    vercel(() => Promise.resolve(Response.json({ deployments: [] })));
    await expect(latestDeployment(ownProject("prj_empty"), "saved-token")).resolves.toEqual({
      kind: "none",
    });
  });

  it("asks again once the founder reconnects, not after the refusal's cache runs out", async () => {
    const refused = vercel(status(401));
    await latestDeployment(ownProject("prj_reconnect"), "saved-token");
    await latestDeployment(ownProject("prj_reconnect"), "saved-token");
    expect(refused.calls).toBe(1);

    vercel(() =>
      Promise.resolve(
        Response.json({ deployments: [{ createdAt: 1, state: "READY", url: "acme.app" }] }),
      ),
    );

    await expect(
      latestDeployment(ownProject("prj_reconnect"), "fresh-token"),
    ).resolves.toMatchObject({ kind: "deployed" });
  });
});

describe("productionHosts", () => {
  const binding = { projectId: "prj_1", projectName: "acme", teamId: "team_1" };

  it("lists the verified domains production answers on, as a URL's host reads", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(url);
      return Promise.resolve(
        Response.json({
          domains: [
            { name: "acme.vercel.app", verified: true },
            { name: "Shop.Acme.dev", verified: true },
            { name: "pending.acme.dev", verified: false },
          ],
          pagination: { count: 3, next: null, prev: null },
        }),
      );
    });

    await expect(productionHosts(binding, "tok")).resolves.toEqual({
      hosts: ["acme.vercel.app", "shop.acme.dev"],
      kind: "listed",
    });
    expect(asked).toEqual([
      "https://api.vercel.com/v9/projects/prj_1/domains?limit=100&production=true&teamId=team_1",
    ]);
  });

  it("tells a refused token apart from Vercel being out of reach", async () => {
    vercel(status(403));
    await expect(productionHosts(binding, "tok")).resolves.toEqual({ kind: "refused" });

    vercel(() => Promise.reject(new TypeError("fetch failed")));
    await expect(productionHosts({ ...binding, teamId: null }, "tok")).resolves.toEqual({
      kind: "unreachable",
      reason: "fetch failed",
    });
  });
});
