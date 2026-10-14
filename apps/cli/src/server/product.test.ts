import { writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { RefusalError } from "./refusal";
import * as store from "./store/store";
import { openProduct, openWorkspacePath } from "./product";
import { foundAcme, freshSave } from "./test-support/save";

freshSave();

beforeEach(() => {
  foundAcme();
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
