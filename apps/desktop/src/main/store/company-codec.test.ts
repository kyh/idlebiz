import { describe, expect, it } from "vitest";
import { companySharedDir } from "@/main/paths";
import type { Company } from "@/shared/domain";
import { companyToDoc, docToCompany } from "./company-codec";
import { parseDoc, serializeDoc } from "./frontmatter";

const acme: Company = {
  autopilot: true,
  budget: { capUsd: 20, mode: "capped" },
  businessType: "software",
  createdAt: 1_699_000_000_000,
  founderName: "Ada",
  founderSpriteSeed: "s",
  id: "acme",
  leaderId: "lead",
  maxAgents: 12,
  mission: "A to-do app that plans itself.",
  name: "Acme",
  revenueUsd: null,
  ships: 0,
  spentUsd: 0,
  users: null,
  workspaceDir: companySharedDir("acme"),
};

const written = (co: Company): string => serializeDoc(companyToDoc(co));

describe("company codec", () => {
  it.each<Company>([acme, { ...acme, mission: null }])(
    "round-trips a mission or its absence",
    (co) => {
      expect(docToCompany(parseDoc(written(co)))).toEqual(co);
    },
  );

  it("writes no description and no mission line for a company with no pitch", () => {
    const text = written({ ...acme, mission: null });
    expect(text).not.toContain("description:");
    expect(text.trimEnd().endsWith("# Acme")).toBe(true);
  });

  it("reads an empty description as no mission", () => {
    const text = written(acme).replace('"A to-do app that plans itself."', '""');
    expect(docToCompany(parseDoc(text)).mission).toBeNull();
  });
});
