import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import bundled from "@/renderer/game/office-design.json";
import { officeLayoutSchema } from "./office-layout-schema";
import type { OfficeObjectDef } from "./office-layout-schema";
import { OFFICE_OBJECT_ASSETS, objectSpritePath, unresolvedArt } from "./office-object-sprite";

const KIT_DIR = "workspace-kit/office-objects/32";

const layout = officeLayoutSchema.parse(bundled);

const floor = (art: Pick<OfficeObjectDef, "id" | "path">): OfficeObjectDef => ({
  ...art,
  layer: "floor",
  x: 0,
  y: 0,
});

describe("art a layout names", () => {
  it("all ships with this build for the bundled office", () => {
    expect(unresolvedArt(layout)).toEqual([]);
  });

  it("names each id with no sprite once, however often it is placed", () => {
    const missing = floor({ id: "nonexistent-object" });
    expect(unresolvedArt({ objects: [...layout.objects, missing, missing] })).toEqual([
      "nonexistent-object",
    ]);
  });

  it("names an object whose sprite was never measured", () => {
    const renamed = floor({ id: "tile-0-0", path: "workspace-kit/room-builder/32/renamed.png" });
    expect(unresolvedArt({ objects: [renamed] })).toEqual(["tile-0-0"]);
  });
});

describe("the office kit", () => {
  it("is every kit PNG that ships, in the order the source pack numbers them", () => {
    const shipped = readdirSync(path.resolve(import.meta.dirname, "../../public", KIT_DIR))
      .filter((file) => file.endsWith(".png"))
      .map((file) => `${KIT_DIR}/${file}`)
      .toSorted();
    expect(OFFICE_OBJECT_ASSETS.map((asset) => asset.path)).toEqual(shipped);
    const numbers = OFFICE_OBJECT_ASSETS.map((asset) => asset.sourceId);
    expect(numbers).toEqual(numbers.toSorted((a, b) => a - b));
  });

  it("names each sprite by its number, and places it by that name", () => {
    expect(OFFICE_OBJECT_ASSETS[0]).toEqual({
      id: "office-object-001",
      path: `${KIT_DIR}/modern-office-32-001.png`,
      sourceId: 1,
    });
    const strays = OFFICE_OBJECT_ASSETS.filter(
      (asset) => objectSpritePath({ id: asset.id }) !== asset.path,
    );
    expect(strays).toEqual([]);
  });
});
