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

/** Answer Vercel as an account with one project, and keep the token each call carried. */
const vercelAccount = (): (string | null)[] => {
  const tokens: (string | null)[] = [];
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    tokens.push(new Headers(init?.headers).get("authorization"));
    const { pathname } = new URL(url);
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
    ok: true,
    projects: [{ id: "prj_acme", name: "acme" }],
  });
  expect(new Set(tokens)).toEqual(new Set(["Bearer saved-token"]));
  expect(getSecret("VERCEL_TOKEN")).toBe("saved-token");
});

it("lists nothing, and asks Vercel nothing, with no token given or saved", async () => {
  const tokens = vercelAccount();

  await expect(listVercelProjects()).resolves.toEqual({ ok: false, projects: [] });
  expect(tokens).toEqual([]);
});
