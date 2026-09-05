import { describe, expect, it } from "vitest";
import type { Product } from "@/shared/domain";
import { parseDoc, serializeDoc } from "./frontmatter";
import { docToProduct, productToDoc } from "./product-codec";

const roundTrip = (p: Product): Product =>
  docToProduct(parseDoc(serializeDoc(productToDoc(p))), p.companyId);

describe("product codec", () => {
  it.each<Product>([
    {
      id: "widget",
      companyId: "acme",
      name: "Widget",
      description: "A widget that widgets.",
      workspaceDir: "/tmp/acme/workspace",
      ships: 3,
      lastShipAt: 1_700_000_000_000,
      users: 42,
      vercel: { projectId: "prj_1", projectName: "widget", teamId: "team_1" },
      createdAt: 1_699_000_000_000,
    },
    {
      id: "gadget",
      companyId: "acme",
      name: "Gadget",
      description: "Not yet anything.",
      workspaceDir: "/tmp/acme/products/gadget/workspace",
      ships: 0,
      lastShipAt: null,
      users: null,
      vercel: null,
      createdAt: 1_699_000_000_000,
    },
    {
      id: "personal-team",
      companyId: "acme",
      name: "Personal",
      description: "On a personal Vercel account.",
      workspaceDir: "/tmp/acme/products/personal-team/workspace",
      ships: 1,
      lastShipAt: null,
      users: 0,
      vercel: { projectId: "prj_2", projectName: "personal", teamId: null },
      createdAt: 1_699_000_000_000,
    },
  ])("round-trips $id", (product) => {
    expect(roundTrip(product)).toEqual(product);
  });
});
