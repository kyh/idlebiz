import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import bundled from "@/renderer/game/office-design.json";
import { OFFICE_LAYOUT_VERSION, officeLayoutSchema } from "@/shared/office-layout-schema";
import type { OfficeLayoutData } from "@/shared/office-layout-schema";
import { RefusalError } from "@/shared/refusal";

const root = mkdtempSync(path.join(tmpdir(), "idlebiz-office-"));
const officeFile = path.join(root, "office-design.json");
const previousRoot = process.env.IDLEBIZ_ROOT_DIR;
process.env.IDLEBIZ_ROOT_DIR = root;
const { loadOfficeDesign, saveOfficeDesign } = await import("./office-design");

const layout = officeLayoutSchema.parse(bundled);
const appRoot = path.resolve(import.meta.dirname, "../..");
const art = {
  publicDir: path.join(appRoot, "public"),
  sheet: path.join(appRoot, "resources", "employee-sheets", "employee-sheet-01.png"),
};
const missingArt: OfficeLayoutData = {
  ...layout,
  objects: [...layout.objects, { id: "nonexistent-object", layer: "floor", x: 0, y: 0 }],
};

// a west and an east room joined by one corridor, the seat in the east one
const corridor = (objects: OfficeLayoutData["objects"]): OfficeLayoutData => ({
  ...layout,
  cell: 16,
  collision: [
    "11111111111111111111",
    "10000111111111100001",
    "10000111111111100001",
    "10000000000000000001",
    "10000111111111100001",
    "11111111111111111111",
  ],
  cols: 20,
  door: { x: 24, y: 24 },
  height: 96,
  objects,
  pois: [],
  rows: 6,
  seats: [{ role: "work", x: 280, y: 24 }],
  spawn: { x: 24, y: 24 },
  width: 320,
});
/** One design2 tile drawn over everyone. */
const overhead = (tile: string, x: number, y: number): OfficeLayoutData["objects"] => [
  { id: tile, layer: "overhead", path: `workspace-kit/design2/${tile}.png`, x, y },
];

beforeEach(() => rmSync(officeFile, { force: true }));

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
  if (previousRoot === undefined) {
    delete process.env.IDLEBIZ_ROOT_DIR;
  } else {
    process.env.IDLEBIZ_ROOT_DIR = previousRoot;
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
    expect(loadOfficeDesign().kind).toBe("unreadable");

    writeFileSync(officeFile, JSON.stringify({ ...bundled, tile: "big" }));
    const design = loadOfficeDesign();
    expect(design.kind === "unreadable" ? design.reason : design.kind).toMatch(/tile/u);
  });

  it("refuses a file naming art this build lacks, so neither scene nor builder draws it", () => {
    writeFileSync(officeFile, JSON.stringify(missingArt));
    expect(loadOfficeDesign()).toEqual({
      kind: "unreadable",
      reason: "missing art: nonexistent-object",
    });
  });

  it("tells a newer build's file apart from a broken one", () => {
    writeFileSync(officeFile, JSON.stringify({ ...bundled, version: OFFICE_LAYOUT_VERSION + 1 }));
    expect(loadOfficeDesign()).toEqual({ kind: "newer" });
  });
});

describe("saving the office", () => {
  it("never replaces a newer build's file", async () => {
    const newer = JSON.stringify({ ...bundled, version: OFFICE_LAYOUT_VERSION + 1 });
    writeFileSync(officeFile, newer);

    const refused = saveOfficeDesign(layout, art);
    await expect(refused).rejects.toThrow("saved by a newer IdleBiz");
    await expect(refused).rejects.toBeInstanceOf(RefusalError);
    expect(readFileSync(officeFile, "utf-8")).toBe(newer);
  });

  it("refuses a layout naming art this build lacks", async () => {
    await expect(saveOfficeDesign(missingArt, art)).rejects.toThrow(
      "missing art: nonexistent-object",
    );
    expect(existsSync(officeFile)).toBe(false);
  });

  // mid-corridor, or at the seat's own doorway
  it.each([144, 208])(
    "refuses a layout whose seat the scene would cut off to keep a face in view (tile at x %i)",
    async (x) => {
      await expect(saveOfficeDesign(corridor(overhead("d2-ow-6-3", x, 16)), art)).rejects.toThrow(
        "seat 0 (work at 280,24) is unreachable from spawn once the spots where furniture hides a face are closed",
      );
      expect(existsSync(officeFile)).toBe(false);
    },
  );

  it("refuses a layout whose sight seal would close the spawn around the founder", async () => {
    await expect(saveOfficeDesign(corridor(overhead("d2-ow-6-3", 8, -16)), art)).rejects.toThrow(
      "spawn 24,24 is inside collision once the spots where furniture hides a face are closed",
    );
    expect(existsSync(officeFile)).toBe(false);
  });

  // a source sheet's top-left frame faces right; judged by it, this seat stays reachable
  it("judges sight by the pose the scene stands the founder in", async () => {
    await expect(saveOfficeDesign(corridor(overhead("d2-fix-117", 120, 14)), art)).rejects.toThrow(
      "seat 0 (work at 280,24) is unreachable from spawn once the spots where furniture hides a face are closed",
    );
    expect(existsSync(officeFile)).toBe(false);
  });
});
