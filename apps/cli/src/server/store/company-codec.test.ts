import { describe, expect, it } from "vitest";
import { sharedDir } from "../paths";
import type { Company } from "@repo/domain/domain";
import { SAVE_FORMAT, SaveFormatError, companyToDoc, docToCompany } from "./company-codec";
import { parseDoc, serializeDoc } from "./frontmatter";
import type { FrontmatterDoc } from "./frontmatter";
import { tempSave } from "../test-support/save";

tempSave();

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
  standingSignOffs: [],
  users: null,
  workspaceDir: sharedDir(),
};

const written = (co: Company) => serializeDoc(companyToDoc(co));

const refusalOf = (doc: FrontmatterDoc) => {
  try {
    docToCompany(doc);

    return null;
  } catch (error) {
    if (error instanceof SaveFormatError) {
      return error;
    }

    throw error;
  }
};

describe("company codec", () => {
  it.each<Company>([acme, { ...acme, mission: null }])(
    "round-trips a mission or its absence",
    (co) => {
      expect(docToCompany(parseDoc(written(co)))).toEqual(co);
    },
  );

  it.each<{ standingSignOffs: Company["standingSignOffs"] }>([
    { standingSignOffs: ["deploy"] },
    { standingSignOffs: ["payments"] },
    { standingSignOffs: ["deploy", "payments"] },
  ])("round-trips standing sign-offs $standingSignOffs", ({ standingSignOffs }) => {
    const co = { ...acme, standingSignOffs };
    expect(docToCompany(parseDoc(written(co)))).toEqual(co);
  });

  it.each([null, ""])("writes no description and no mission line for mission %j", (mission) => {
    const text = written({ ...acme, mission });
    expect(text).not.toContain("description:");
    expect(text.trimEnd().endsWith("# Acme")).toBe(true);
  });

  it.each([
    { format: SAVE_FORMAT - 1, writtenBy: "pre-release" },
    { format: SAVE_FORMAT + 1, writtenBy: "newer" },
  ])("refuses a save stamped format $format as a $writtenBy build's", ({ format, writtenBy }) => {
    const doc = parseDoc(written(acme));
    doc.metadata.format = format;
    expect(refusalOf(doc)?.writtenBy).toBe(writtenBy);
  });

  it("refuses a save with no stamp as a pre-release build's", () => {
    const doc = parseDoc(written(acme));
    delete doc.metadata.format;
    expect(refusalOf(doc)?.writtenBy).toBe("pre-release");
  });
});
