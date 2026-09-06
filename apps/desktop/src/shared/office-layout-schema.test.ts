import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import bundled from "@/renderer/game/office-design.json";
import type { JsonValue } from "./json";
import {
  MAX_FLOOR_LINE,
  OFFICE_LAYOUT_VERSION,
  canonicalOfficeLayout,
  officeLayoutSchema,
  parseOfficeLayout,
  schemaIssues,
  type OfficeLayoutData,
} from "./office-layout-schema";

/** A v1 office: the world and its workstations, nothing else. */
const legacy: JsonValue = {
  tile: 32,
  width: 64,
  height: 64,
  cell: 16,
  cols: 4,
  rows: 4,
  spawn: { x: 24, y: 24 },
  objects: [
    { id: "floor-a", layer: "floor", x: 0, y: 0, path: "tiles/a.png" },
    { id: "office-object-desk", layer: "object", x: 0, y: 0, anchorY: 32, flipX: true },
  ],
  collision: ["1111", "1001", "1001", "1111"],
  workSeats: [{ x: 24, y: 40 }],
};

describe("parseOfficeLayout", () => {
  it("upgrades a v1 layout: seats become work seats, the door is the spawn, no POIs", () => {
    const out = parseOfficeLayout(legacy);
    expect(out.version).toBe(OFFICE_LAYOUT_VERSION);
    expect(out.seats).toEqual([{ role: "work", x: 24, y: 40 }]);
    expect(out.door).toEqual({ x: 24, y: 24 });
    expect(out.pois).toEqual([]);
    expect(out.objects).toHaveLength(2);
  });

  it("accepts a v2 layout as-is", () => {
    const v2 = canonicalOfficeLayout(parseOfficeLayout(legacy));
    expect(parseOfficeLayout(v2)).toEqual(v2);
  });

  it("rejects a layout that fits neither schema, naming the current one", () => {
    expect(() => parseOfficeLayout({ version: 2, tile: 32 })).toThrow(/schema v2/);
    expect(() => parseOfficeLayout("nope")).toThrow(/schema v2/);
  });

  it("holds a floor line at the top of the entity band and rejects the next one", () => {
    const withAnchor = (anchorY: number): JsonValue => ({
      ...legacy,
      objects: [{ id: "x", layer: "object", x: 0, y: 0, anchorY }],
    });
    expect(parseOfficeLayout(withAnchor(MAX_FLOOR_LINE)).objects).toHaveLength(1);
    expect(() => parseOfficeLayout(withAnchor(MAX_FLOOR_LINE + 1))).toThrow(/anchorY/);
  });

  it("rejects an object with nothing to resolve a sprite from", () => {
    const blank: JsonValue = {
      ...legacy,
      objects: [{ id: "", layer: "overhead", x: 0, y: 0 }],
    };
    expect(() => parseOfficeLayout(blank)).toThrow(/id/);
  });

  it("rejects a collision row that is not 0s and 1s", () => {
    const smudged: JsonValue = { ...legacy, collision: ["1111", "1x01", "1001", "1111"] };
    expect(() => parseOfficeLayout(smudged)).toThrow(/0s and 1s/);
  });

  it("rejects a rest seat without a side to sit on", () => {
    const v2 = canonicalOfficeLayout(parseOfficeLayout(legacy));
    const bad: JsonValue = { ...v2, seats: [{ role: "rest", x: 24, y: 40 }] };
    expect(() => parseOfficeLayout(bad)).toThrow(/sit/);
  });

  it("ships the bundled office at the current version, with the semantic layer filled in", () => {
    const out = officeLayoutSchema.parse(bundled);
    expect(out.version).toBe(OFFICE_LAYOUT_VERSION);
    expect(out.seats.filter((s) => s.role === "work").length).toBeGreaterThan(0);
    expect(out.pois.length).toBeGreaterThan(0);
  });
});

describe("schemaIssues", () => {
  it("is empty for a layout that parses", () => {
    expect(schemaIssues(parseOfficeLayout(legacy))).toEqual([]);
  });

  it("names the field when typed data still breaks a bound", () => {
    const data: OfficeLayoutData = parseOfficeLayout(legacy);
    const tooTall: OfficeLayoutData = {
      ...data,
      objects: [{ id: "x", layer: "object", x: 0, y: 0, anchorY: MAX_FLOOR_LINE + 1 }],
    };
    expect(schemaIssues(tooTall)).toEqual([expect.stringMatching(/^objects\.0\.anchorY: /)]);
  });
});

describe("canonicalOfficeLayout", () => {
  it("stamps the version, fixes key order, and drops unset optional keys", () => {
    const parsed: OfficeLayoutData = parseOfficeLayout(legacy);
    const out = canonicalOfficeLayout(parsed);
    expect(Object.keys(out)).toEqual([
      "version",
      "tile",
      "width",
      "height",
      "cell",
      "cols",
      "rows",
      "spawn",
      "door",
      "seats",
      "pois",
      "objects",
      "collision",
    ]);
    expect(out.objects[0]).toEqual({
      layer: "floor",
      id: "floor-a",
      x: 0,
      y: 0,
      path: "tiles/a.png",
    });
    expect(out.objects[1]).toEqual({
      layer: "object",
      anchorY: 32,
      id: "office-object-desk",
      x: 0,
      y: 0,
      flipX: true,
    });
    expect(JSON.stringify(out)).not.toContain("flipY");
  });

  it("re-saves the bundled office byte for byte", () => {
    // main writes exactly this; a dev save mirrors it into the repo, so any drift
    // in key order would land as a diff over every row of the bundled file
    const file = resolve(import.meta.dirname, "../renderer/game/office-design.json");
    const text = readFileSync(file, "utf8");
    const raw: JsonValue = JSON.parse(text);
    const saved = `${JSON.stringify(canonicalOfficeLayout(parseOfficeLayout(raw)), null, 2)}\n`;
    expect(saved).toBe(text);
  });
});
