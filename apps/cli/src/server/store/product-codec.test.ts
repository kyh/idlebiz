import { describe, expect, it } from "vitest";
import { COMPANY_WORKSPACE, ROOT_DIR, productWorkspace } from "../paths";
import type { Product } from "@repo/domain/domain";
import { parseDoc, serializeDoc } from "./frontmatter";
import { docToProduct, productToDoc } from "./product-codec";

const roundTrip = (p: Product): Product => docToProduct(parseDoc(serializeDoc(productToDoc(p))));

const widget: Product = {
  createdAt: 1_699_000_000_000,
  description: "A widget that widgets.",
  id: "widget",
  lastShipAt: 1_700_000_000_000,
  name: "Widget",
  revenueUsd: 12.5,
  ships: 3,
  users: 42,
  vercel: { projectId: "prj_1", projectName: "widget", teamId: "team_1" },
  workspaceDir: COMPANY_WORKSPACE,
};

const gadget: Product = {
  createdAt: 1_699_000_000_000,
  description: "Not yet anything.",
  id: "gadget",
  lastShipAt: null,
  name: "Gadget",
  revenueUsd: null,
  ships: 0,
  users: null,
  vercel: null,
  workspaceDir: productWorkspace("gadget"),
};

describe("product codec", () => {
  it.each<Product>([
    widget,
    gadget,
    {
      createdAt: 1_699_000_000_000,
      description: "On a personal Vercel account.",
      id: "personal-team",
      lastShipAt: null,
      name: "Personal",
      revenueUsd: null,
      ships: 1,
      users: 0,
      vercel: { projectId: "prj_2", projectName: "personal", teamId: null },
      workspaceDir: productWorkspace("personal-team"),
    },
  ])("round-trips $id", (product) => {
    expect(roundTrip(product)).toEqual(product);
  });

  it("writes which workspace a product works in, never the path", () => {
    expect(productToDoc(widget).metadata.workspace).toBe("company");
    expect(productToDoc(gadget).metadata.workspace).toBe("own");
    expect(serializeDoc(productToDoc(gadget))).not.toContain(ROOT_DIR);
  });
});
