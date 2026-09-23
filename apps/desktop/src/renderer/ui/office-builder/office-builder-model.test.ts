import { describe, expect, it } from "vitest";
import {
  ALL_OBJECT_IDS,
  ROOM_TILES,
  assetSrc,
  autoAnchor,
  flipObject,
  moveObject,
  srcForObject,
} from "./office-builder-model";
import type { EditableObject } from "./office-builder-model";

// The packaged app loads the renderer over file://, where a root-absolute src lands at
// the filesystem root instead of beside index.html.
const page = "file:///Applications/IdleBiz.app/Contents/Resources/app.asar/renderer/index.html#/ui";
const rendererDir = new URL("./", page).href;
const missesPage = (src: string | null): boolean =>
  src === null || !new URL(src, page).href.startsWith(rendererDir);

describe("builder sprite srcs", () => {
  it("resolve beside a file:// page for every catalog sprite", () => {
    expect(ALL_OBJECT_IDS.filter((id) => missesPage(assetSrc(id)))).toEqual([]);
    expect(ALL_OBJECT_IDS.filter((id) => missesPage(srcForObject({ id })))).toEqual([]);
  });

  it("resolve beside a file:// page for every room tile", () => {
    const placed = ROOM_TILES.map((t) => srcForObject({ id: t.id, path: t.path }));
    expect(placed.filter(missesPage)).toEqual([]);
  });

  it("has no src for an id the catalog does not know", () => {
    expect(assetSrc("no-such-object")).toBeNull();
    expect(srcForObject({ id: "no-such-object" })).toBeNull();
  });
});

// office-object-001 is a 64x96 canvas whose content is the bottom 14px, so a vertical
// flip moves its content bottom from 96 to 14. The anchor sits 5px above that bottom on
// purpose: an authored floor line the builder has no way to rederive.
const desk = {
  anchorY: 60 + 96 - 5,
  flipX: false,
  flipY: false,
  id: "office-object-001",
  layer: "object",
  solid: true,
  uid: "desk",
  x: 40,
  y: 60,
} satisfies EditableObject;
const anchorOf = (o: EditableObject): number | null => (o.layer === "object" ? o.anchorY : null);

describe("a y-sorted object's floor line", () => {
  it("travels with the object when it moves", () => {
    const moved = [
      moveObject(desk, 41, 60),
      moveObject(desk, 40, 61),
      moveObject(desk, 72, 13),
      moveObject(moveObject(desk, 40, 200), 40, 60),
    ];
    expect(moved.map((o) => (anchorOf(o) ?? Number.NaN) - o.y)).toEqual([91, 91, 91, 91]);
  });

  it("moves by the change in content bottom on a vertical flip, and back again", () => {
    const flipped = flipObject(desk, "y");
    expect(anchorOf(flipped)).toBe(desk.anchorY - 82);
    expect(anchorOf(flipObject(flipped, "y"))).toBe(desk.anchorY);
  });

  it("stays put on a horizontal flip", () => {
    expect(anchorOf(flipObject(desk, "x"))).toBe(desk.anchorY);
  });

  it("snaps to the content bottom only when asked", () => {
    expect(autoAnchor(desk).anchorY).toBe(60 + 96);
    expect(autoAnchor({ ...desk, flipY: true }).anchorY).toBe(60 + 14);
  });
});
