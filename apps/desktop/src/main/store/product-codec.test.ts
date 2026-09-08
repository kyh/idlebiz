import { describe, expect, it } from "vitest";
import type { Product } from "@/shared/domain";
import { parseDoc, serializeDoc } from "./frontmatter";
import { docToProduct, productToDoc } from "./product-codec";

const roundTrip = (p: Product): Product =>
  docToProduct(parseDoc(serializeDoc(productToDoc(p))), p.companyId);

describe("product codec", () => {
  it.each<Product>([
    {
      companyId: "acme",
      createdAt: 1_699_000_000_000,
      description: "A widget that widgets.",
      id: "widget",
      lastShipAt: 1_700_000_000_000,
      name: "Widget",
      ships: 3,
      users: 42,
      vercel: { projectId: "prj_1", projectName: "widget", teamId: "team_1" },
      workspaceDir: "/tmp/acme/workspace",
    },
    {
      companyId: "acme",
      createdAt: 1_699_000_000_000,
      description: "Not yet anything.",
      id: "gadget",
      lastShipAt: null,
      name: "Gadget",
      ships: 0,
      users: null,
      vercel: null,
      workspaceDir: "/tmp/acme/products/gadget/workspace",
    },
    {
      companyId: "acme",
      createdAt: 1_699_000_000_000,
      description: "On a personal Vercel account.",
      id: "personal-team",
      lastShipAt: null,
      name: "Personal",
      ships: 1,
      users: 0,
      vercel: { projectId: "prj_2", projectName: "personal", teamId: null },
      workspaceDir: "/tmp/acme/products/personal-team/workspace",
    },
  ])("round-trips $id", (product) => {
    expect(roundTrip(product)).toEqual(product);
  });
});
