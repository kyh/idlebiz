import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-vercel-"));
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
const previousToken = process.env["VERCEL_TOKEN"];
process.env["IDLEBIZ_ROOT_DIR"] = root;

const store = await import("@/main/store/store");
const { getSecret, setSecret } = await import("@/main/secrets");
const { connectVercel, disconnectVercel } = await import("./vercel-connect");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
});

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
  const company = store.foundCompany({
    budget: { mode: "infinite" },
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [],
    mission: "ship",
    name: "Acme",
  });
  const [product] = store.listProducts(company.id);
  if (!product) {
    throw new Error("missing founding product");
  }
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
