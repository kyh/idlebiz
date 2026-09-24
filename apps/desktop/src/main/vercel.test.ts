import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-vercel-api-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;

const { setSecret } = await import("@/main/secrets");
const { latestDeployment, projectAccount, visitQuery } = await import("./vercel");

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

const project = { projectId: "prj_1", teamId: "team_1" };

describe("visitQuery", () => {
  it("asks for every visit when given no window", () => {
    expect(visitQuery({ projectId: "prj_1", teamId: null }, {})).toEqual({ projectId: "prj_1" });
  });

  it("sends since and until together: the API refuses one without the other", () => {
    const query = visitQuery(project, { span: { since: 0, until: 86_400_000 } });
    expect(query).toMatchObject({
      since: "1970-01-01T00:00:00.000Z",
      teamId: "team_1",
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

describe("latestDeployment", () => {
  beforeEach(() => setSecret("VERCEL_TOKEN", "saved-token"));
  afterEach(() => vi.unstubAllGlobals());

  it("reads the latest production deploy", async () => {
    vercel(() =>
      Promise.resolve(
        Response.json({
          deployments: [{ createdAt: 5, readyState: "READY", url: "acme.vercel.app" }],
        }),
      ),
    );

    await expect(latestDeployment("prj_live")).resolves.toEqual({
      deployment: { createdAt: 5, state: "READY", url: "https://acme.vercel.app" },
      kind: "deployed",
    });
  });

  it("tells a refused token apart from nothing deployed", async () => {
    vercel(status(401));
    await expect(latestDeployment("prj_revoked")).resolves.toEqual({ kind: "refused" });

    vercel(status(403));
    await expect(latestDeployment("prj_other_team", "team_1")).resolves.toEqual({
      kind: "refused",
    });
  });

  it("reads an outage or an empty project as nothing deployed", async () => {
    vercel(status(500));
    await expect(latestDeployment("prj_down")).resolves.toEqual({ kind: "none" });

    vercel(() => Promise.reject(new TypeError("fetch failed")));
    await expect(latestDeployment("prj_offline")).resolves.toEqual({ kind: "none" });

    vercel(() => Promise.resolve(Response.json({ deployments: [] })));
    await expect(latestDeployment("prj_empty")).resolves.toEqual({ kind: "none" });
  });

  it("asks again once the founder reconnects, not after the refusal's cache runs out", async () => {
    const refused = vercel(status(401));
    await latestDeployment("prj_reconnect");
    await latestDeployment("prj_reconnect");
    expect(refused.calls).toBe(1);

    setSecret("VERCEL_TOKEN", "fresh-token");
    vercel(() =>
      Promise.resolve(
        Response.json({ deployments: [{ createdAt: 1, state: "READY", url: "acme.app" }] }),
      ),
    );

    await expect(latestDeployment("prj_reconnect")).resolves.toMatchObject({ kind: "deployed" });
  });
});

describe("projectAccount", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes a team project's team without asking", async () => {
    const asked = vercel(status(500));
    await expect(projectAccount(project, "token")).resolves.toBe("team_1");
    expect(asked.calls).toBe(0);
  });

  it("asks Vercel who owns a project listed with no team", async () => {
    vercel(() => Promise.resolve(Response.json({ accountId: "team_hobby", id: "prj_2" })));
    await expect(projectAccount({ projectId: "prj_2", teamId: null }, "token")).resolves.toBe(
      "team_hobby",
    );

    vercel(status(404));
    await expect(projectAccount({ projectId: "prj_gone", teamId: null }, "token")).rejects.toThrow(
      "404",
    );
  });
});
