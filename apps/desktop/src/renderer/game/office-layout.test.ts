import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import rawLayout from "@/renderer/game/office-design.json";
import { authoredGrid, bodyBlockedAt, findPath } from "@/shared/office-grid";
import { officeLayoutSchema } from "@/shared/office-layout-schema";
import { OFFICE } from "./office-layout";

// office-design.json is parsed as the renderer loads, so a hand edit that breaks it blanks
// the app before React can show a crash screen; this is the only thing that reads it first.
const layout = officeLayoutSchema.parse(rawLayout);
const publicDir = path.resolve(import.meta.dirname, "../../../public");

describe("the bundled office", () => {
  it("has a collision grid of the size it claims", () => {
    expect(layout.collision).toHaveLength(layout.rows);
    for (const row of layout.collision) {
      expect(row).toHaveLength(layout.cols);
    }
  });

  it("draws only art the app ships", () => {
    const missing = [...new Set(layout.objects.map((obj) => obj.path))].filter(
      (file) => !existsSync(path.join(publicDir, file)),
    );
    expect(missing).toEqual([]);
  });

  it("places the founder where they can step", () => {
    expect(bodyBlockedAt(OFFICE.grid, OFFICE.spawn.x, OFFICE.spawn.y)).toBe(false);
  });

  // judged on the authored grid: the walk grid seals pockets, so a walled-off seat would
  // snap to floor on the far side of its wall and pass
  it("lets a walker from spawn reach every seat, point of interest and door", () => {
    const grid = authoredGrid(layout);
    const spots = [layout.door, ...layout.seats, ...layout.pois];
    const unreachable = spots.filter((spot) => findPath(grid, layout.spawn, spot) === null);
    expect(unreachable).toEqual([]);
  });

  it("walks idlers onto the exact spot of every point of interest and the door", () => {
    const missed = [layout.door, ...layout.pois].filter((spot) => {
      const end = findPath(OFFICE.grid, OFFICE.spawn, spot)?.at(-1);
      return end?.x !== spot.x || end.y !== spot.y;
    });
    expect(missed).toEqual([]);
  });
});
