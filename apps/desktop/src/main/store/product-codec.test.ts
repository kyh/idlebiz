import { describe, expect, it } from "vitest";
import { ROOT_DIR, companyWorkspace, productWorkspace } from "@/main/paths";
import type { Product } from "@/shared/domain";
import { parseDoc, serializeDoc } from "./frontmatter";
import { docToProduct, productToDoc } from "./product-codec";

const roundTrip = (p: Product): Product =>
  docToProduct(parseDoc(serializeDoc(productToDoc(p))), p.companyId);

const widget: Product = {
  companyId: "acme",
  createdAt: 1_699_000_000_000,
  description: "A widget that widgets.",
  id: "widget",
  lastShipAt: 1_700_000_000_000,
  name: "Widget",
  revenueUsd: 12.5,
  ships: 3,
  users: 42,
  vercel: { projectId: "prj_1", projectName: "widget", teamId: "team_1" },
  workspaceDir: companyWorkspace("acme"),
};

const gadget: Product = {
  companyId: "acme",
  createdAt: 1_699_000_000_000,
  description: "Not yet anything.",
  id: "gadget",
  lastShipAt: null,
  name: "Gadget",
  revenueUsd: null,
  ships: 0,
  users: null,
  vercel: null,
  workspaceDir: productWorkspace("acme", "gadget"),
};

describe("product codec", () => {
  it.each<Product>([
    widget,
    gadget,
    {
      companyId: "acme",
      createdAt: 1_699_000_000_000,
      description: "On a personal Vercel account.",
      id: "personal-team",
      lastShipAt: null,
      name: "Personal",
      revenueUsd: null,
      ships: 1,
      users: 0,
      vercel: { projectId: "prj_2", projectName: "personal", teamId: null },
      workspaceDir: productWorkspace("acme", "personal-team"),
    },
  ])("round-trips $id", (product) => {
    expect(roundTrip(product)).toEqual(product);
  });

  it("writes which workspace a product works in, never the path", () => {
    expect(productToDoc(widget).metadata.workspace).toBe("company");
    expect(productToDoc(gadget).metadata.workspace).toBe("own");
    expect(serializeDoc(productToDoc(gadget))).not.toContain(ROOT_DIR);
  });

  it("reads a product that names no workspace as sharing the company's", () => {
    const doc = productToDoc(gadget);
    const { workspace: _, ...metadata } = doc.metadata;
    expect(docToProduct({ ...doc, metadata }, "acme").workspaceDir).toBe(companyWorkspace("acme"));
  });
});
