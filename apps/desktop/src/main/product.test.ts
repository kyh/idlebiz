import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RefusalError } from "@/shared/refusal";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-product-"));
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const store = await import("./store/store");
const { openProduct, openWorkspacePath } = await import("./product");

beforeEach(() => {
  rmSync(root, { force: true, recursive: true });
  store.initStore();
  store.foundCompany({
    budget: { mode: "infinite" },
    businessType: "software",
    founderName: "Kai",
    founderSpriteSeed: "seed",
    hires: [],
    mission: "ship",
    name: "Acme",
  });
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
  }
});

describe("opening from the workspace", () => {
  it("turns away a link to nothing as the founder's answer, not a fault", async () => {
    await expect(openWorkspacePath("gone.md")).rejects.toBeInstanceOf(RefusalError);
  });

  it("turns away an entry outside the product's workspace as the founder's answer", async () => {
    const [product] = store.listProducts();
    if (product === undefined) {
      throw new Error("a company is founded with its first product");
    }
    writeFileSync(path.join(product.workspaceDir, "PRODUCT.md"), "entry: ../../../../etc/hosts\n");
    await expect(openProduct(product.id)).rejects.toBeInstanceOf(RefusalError);
  });
});
