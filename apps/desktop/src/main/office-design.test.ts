import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import bundled from "@/renderer/game/office-design.json";
import { OFFICE_LAYOUT_VERSION, officeLayoutSchema } from "@/shared/office-layout-schema";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-office-"));
const officeFile = path.join(root, "office-design.json");
const previousRoot = process.env["IDLEBIZ_ROOT_DIR"];
process.env["IDLEBIZ_ROOT_DIR"] = root;
const { loadOfficeDesign, saveOfficeDesign } = await import("./office-design");

const layout = officeLayoutSchema.parse(bundled);

beforeEach(() => rmSync(officeFile, { force: true }));

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env["IDLEBIZ_ROOT_DIR"];
  } else {
    process.env["IDLEBIZ_ROOT_DIR"] = previousRoot;
  }
});

describe("loading the saved office", () => {
  it("is absent before the founder saves one", () => {
    expect(loadOfficeDesign()).toEqual({ kind: "absent" });
  });

  it("parses a file this build wrote", () => {
    writeFileSync(officeFile, JSON.stringify(bundled));
    expect(loadOfficeDesign()).toEqual({ kind: "saved", layout });
  });

  it("says why a broken file can't be read instead of passing it off as absent", () => {
    writeFileSync(officeFile, '{"version":2,');
    expect(loadOfficeDesign()).toEqual({ kind: "unreadable", reason: expect.any(String) });

    writeFileSync(officeFile, JSON.stringify({ ...bundled, tile: "big" }));
    expect(loadOfficeDesign()).toEqual({
      kind: "unreadable",
      reason: expect.stringMatching(/tile/u),
    });
  });

  it("tells a newer build's file apart from a broken one", () => {
    writeFileSync(officeFile, JSON.stringify({ ...bundled, version: OFFICE_LAYOUT_VERSION + 1 }));
    expect(loadOfficeDesign()).toEqual({ kind: "newer" });
  });
});

describe("saving the office", () => {
  it("never replaces a newer build's file", () => {
    const newer = JSON.stringify({ ...bundled, version: OFFICE_LAYOUT_VERSION + 1 });
    writeFileSync(officeFile, newer);

    expect(() => saveOfficeDesign(layout)).toThrow("saved by a newer IdleBiz");
    expect(readFileSync(officeFile, "utf-8")).toBe(newer);
  });
});
