import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-vercel-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
const previousToken = process.env["VERCEL_TOKEN"];
process.env["IDLEBIZ_ROOT_DIR"] = root;

const store = await import("@/main/store/store");
const { getSecret, setSecret } = await import("@/main/secrets");
const { connectVercel, disconnectVercel, listVercelProjects } = await import("./vercel-connect");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});
afterEach(() => vi.unstubAllGlobals());

const foundProduct = () => {
  store.foundCompany({
    budget: { mode: "infinite" },
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [],
    mission: "ship",
    name: "Acme",
  });
  const [product] = store.listProducts();
  if (!product) {
    throw new Error("missing founding product");
  }
  return product;
};

/** How Vercel answers one call instead of the one-project account; null keeps the account's answer. */
type Override = (call: { pathname: string; teamId: string | null }) => Promise<Response> | null;

/** Answer Vercel as an account with one project, and keep the token each call carried. */
const vercelAccount = (override: Override = () => null): (string | null)[] => {
  const tokens: (string | null)[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    tokens.push(new Headers(init?.headers).get("authorization"));
    const { pathname, searchParams } = new URL(url);
    const overridden = override({ pathname, teamId: searchParams.get("teamId") });
    if (overridden) {
      return overridden;
    }
    if (pathname === "/v2/user") {
      return Promise.resolve(Response.json({ user: { username: "kai" } }));
    }
    if (pathname === "/v2/teams") {
      return Promise.resolve(Response.json({ teams: [] }));
    }
    return Promise.resolve(Response.json({ projects: [{ id: "prj_acme", name: "acme" }] }));
  });
  return tokens;
};

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env["IDLEBIZ_ROOT_DIR"];
  } else {
    process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
  }
  if (previousToken === undefined) {
    delete process.env["VERCEL_TOKEN"];
  } else {
    process.env["VERCEL_TOKEN"] = previousToken;
  }
});

it("rejects an unknown product before replacing the founder's credential", () => {
  setSecret("VERCEL_TOKEN", "existing-token");

  expect(() =>
    connectVercel({
      productId: "missing",
      projectId: "prj_new",
      projectName: "new-project",
      token: "replacement-token",
    }),
  ).toThrow();

  expect(getSecret("VERCEL_TOKEN")).toBe("existing-token");
  expect(process.env["VERCEL_TOKEN"]).toBe("existing-token");
});

it("unbinds the active product without removing the credential shared with older saves", () => {
  const product = foundProduct();
  connectVercel({
    productId: product.id,
    projectId: "prj_acme",
    projectName: "acme",
    token: "shared-token",
  });

  disconnectVercel(product.id);
  store.initStore();

  expect(store.requireProduct(product.id).vercel).toBeNull();
  expect(getSecret("VERCEL_TOKEN")).toBe("shared-token");
});

it("binds a product with the saved token when none is given, leaving it as it was", () => {
  setSecret("VERCEL_TOKEN", "saved-token");
  const product = foundProduct();

  connectVercel({ productId: product.id, projectId: "prj_acme", projectName: "acme" });

  expect(store.requireProduct(product.id).vercel?.projectId).toBe("prj_acme");
  expect(getSecret("VERCEL_TOKEN")).toBe("saved-token");
});

it("lists the saved token's projects when none is given", async () => {
  setSecret("VERCEL_TOKEN", "saved-token");
  const tokens = vercelAccount();

  const listed = await listVercelProjects();

  expect(listed).toEqual({
    account: "kai",
    kind: "loaded",
    projects: [{ id: "prj_acme", name: "acme" }],
  });
  expect(new Set(tokens)).toEqual(new Set(["Bearer saved-token"]));
  expect(getSecret("VERCEL_TOKEN")).toBe("saved-token");
});

it("lists nothing, and asks Vercel nothing, with no token given or saved", async () => {
  const tokens = vercelAccount();

  await expect(listVercelProjects()).resolves.toEqual({ kind: "rejected" });
  expect(tokens).toEqual([]);
});

const status = (code: number) => Promise.resolve(new Response("{}", { status: code }));

it("rejects a token Vercel refuses", async () => {
  vercelAccount(({ pathname }) => (pathname === "/v2/user" ? status(403) : null));
  await expect(listVercelProjects("revoked")).resolves.toEqual({ kind: "rejected" });

  vercelAccount(({ pathname }) => (pathname === "/v2/user" ? status(401) : null));
  await expect(listVercelProjects("mistyped")).resolves.toEqual({ kind: "rejected" });
});

it("tells Vercel out of reach apart from a rejected token", async () => {
  vercelAccount(() => Promise.reject(new TypeError("fetch failed")));
  await expect(listVercelProjects("offline")).resolves.toEqual({
    kind: "unreachable",
    reason: "fetch failed",
  });

  vercelAccount(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
  await expect(listVercelProjects("slow")).resolves.toMatchObject({ kind: "unreachable" });
});

/** Two teams beside the personal account, each with a project. */
const twoTeams: Override = ({ pathname, teamId }) => {
  if (pathname === "/v2/teams") {
    return Promise.resolve(Response.json({ teams: [{ id: "team_a" }, { id: "team_b" }] }));
  }
  if (teamId !== null) {
    return Promise.resolve(Response.json({ projects: [{ id: `prj_${teamId}`, name: teamId }] }));
  }
  return null;
};

it("fails the listing when one team is down, rather than listing it short", async () => {
  vercelAccount((call) => (call.teamId === "team_a" ? status(500) : twoTeams(call)));

  await expect(listVercelProjects("token")).resolves.toMatchObject({ kind: "unreachable" });
});

it("keeps every other project when the token is refused one team", async () => {
  vercelAccount((call) => (call.teamId === "team_a" ? status(403) : twoTeams(call)));

  await expect(listVercelProjects("token")).resolves.toEqual({
    account: "kai",
    kind: "loaded",
    projects: [
      { id: "prj_acme", name: "acme" },
      { id: "prj_team_b", name: "team_b", teamId: "team_b" },
    ],
  });
});

it("lists a team-scoped token's projects when it is refused the personal account", async () => {
  vercelAccount((call) =>
    call.pathname === "/v9/projects" && call.teamId === null ? status(403) : twoTeams(call),
  );

  await expect(listVercelProjects("token")).resolves.toEqual({
    account: "kai",
    kind: "loaded",
    projects: [
      { id: "prj_team_a", name: "team_a", teamId: "team_a" },
      { id: "prj_team_b", name: "team_b", teamId: "team_b" },
    ],
  });
});

it("lists a token's own projects when it is refused the team list", async () => {
  vercelAccount(({ pathname }) => (pathname === "/v2/teams" ? status(403) : null));

  await expect(listVercelProjects("token")).resolves.toEqual({
    account: "kai",
    kind: "loaded",
    projects: [{ id: "prj_acme", name: "acme" }],
  });
});

it("names the team of a project that shares its name with a personal one", async () => {
  vercelAccount(({ pathname, teamId }) => {
    if (pathname === "/v2/teams") {
      return Promise.resolve(
        Response.json({
          teams: [
            { id: "team_a", name: "Acme Inc", slug: "acme-inc" },
            { id: "team_b", name: null, slug: "side-gig" },
          ],
        }),
      );
    }
    return teamId === null
      ? null
      : Promise.resolve(Response.json({ projects: [{ id: `prj_${teamId}`, name: "acme" }] }));
  });

  await expect(listVercelProjects("token")).resolves.toEqual({
    account: "kai",
    kind: "loaded",
    projects: [
      { id: "prj_acme", name: "acme" },
      { id: "prj_team_a", name: "acme", teamId: "team_a", teamName: "Acme Inc" },
      { id: "prj_team_b", name: "acme", teamId: "team_b", teamName: "side-gig" },
    ],
  });
});

it("lists a project the personal account and its team both return once, under the team", async () => {
  vercelAccount(({ pathname, teamId }) => {
    if (pathname === "/v2/teams") {
      return Promise.resolve(Response.json({ teams: [{ id: "team_a", name: "Acme Inc" }] }));
    }
    return teamId === null
      ? null
      : Promise.resolve(
          Response.json({
            projects: [
              { id: "prj_acme", name: "acme" },
              { id: "prj_docs", name: "docs" },
            ],
          }),
        );
  });

  await expect(listVercelProjects("token")).resolves.toEqual({
    account: "kai",
    kind: "loaded",
    projects: [
      { id: "prj_acme", name: "acme", teamId: "team_a", teamName: "Acme Inc" },
      { id: "prj_docs", name: "docs", teamId: "team_a", teamName: "Acme Inc" },
    ],
  });
});
