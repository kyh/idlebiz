import { describe, expect, it } from "vitest";
import bundled from "@/renderer/game/office-design.json";
import { officeLayoutSchema } from "./office-layout-schema";
import type { OfficeObjectDef } from "./office-layout-schema";
import { unresolvedArt } from "./office-object-sprite";

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
