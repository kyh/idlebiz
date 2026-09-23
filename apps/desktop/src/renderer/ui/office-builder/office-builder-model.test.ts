import { describe, expect, it } from "vitest";
import { layoutIssues } from "@/shared/office-grid";
import { objectSpritePath } from "@/shared/office-object-sprite";
import { SPRITE_BOUNDS } from "@/shared/sprite-bounds.generated";
import {
  ALL_OBJECT_IDS,
  ROOM_TILES,
  addSelected,
  assetSrc,
  autoAnchor,
  duplicates,
  flipObject,
  loadLayout,
  makeObject,
  moveObject,
  moveObjects,
  paintCell,
  sealPockets,
  setCollisionCell,
  srcForObject,
  toLayoutData,
  withLayout,
  worldRect,
} from "./office-builder-model";
import type { BuilderDoc, EditableLayout, EditableObject } from "./office-builder-model";

// The packaged app loads the renderer over file://, where a root-absolute src lands at
// the filesystem root instead of beside index.html.
const page = "file:///Applications/IdleBiz.app/Contents/Resources/app.asar/renderer/index.html#/ui";
const rendererDir = new URL("./", page).href;
const missesPage = (src: string): boolean => !new URL(src, page).href.startsWith(rendererDir);

describe("builder sprite srcs", () => {
  it("resolve beside a file:// page for every catalog sprite", () => {
    expect(ALL_OBJECT_IDS.filter((id) => missesPage(assetSrc(id)))).toEqual([]);
    expect(ALL_OBJECT_IDS.filter((id) => missesPage(srcForObject({ id })))).toEqual([]);
  });

  it("resolve beside a file:// page for every room tile", () => {
    const placed = ROOM_TILES.map((t) => srcForObject({ id: t.id, path: t.path }));
    expect(placed.filter(missesPage)).toEqual([]);
  });

  it("refuses an id the catalog does not know", () => {
    expect(() => assetSrc("no-such-object")).toThrow(/no-such-object/u);
    expect(() => srcForObject({ id: "no-such-object" })).toThrow(/no-such-object/u);
  });
});

const unmeasured = (sprites: readonly string[]): string[] =>
  sprites.filter((sprite) => !SPRITE_BOUNDS.has(sprite));

describe("builder sprite bounds", () => {
  it("are measured for everything the palette places and the shipped office draws", () => {
    expect(unmeasured(ALL_OBJECT_IDS.map(assetSrc))).toEqual([]);
    expect(unmeasured(ROOM_TILES.map((t) => t.path))).toEqual([]);
    expect(unmeasured(loadLayout().objects.map(srcForObject))).toEqual([]);
  });

  // d2-mirb-60-16 is a 32x32 canvas whose content is the bottom 6px: the box a click
  // hits and the line a walker sorts on are its content, not the canvas
  const rail = { id: "d2-mirb-60-16", path: "workspace-kit/design2/d2-mirb-60-16.png" };

  it("come from the PNG the object draws", () => {
    const placed = { ...rail, flipX: false, flipY: false, x: 180, y: 70 };
    expect(worldRect(placed)).toEqual({ h: 6, w: 32, x: 180, y: 96 });
    expect(worldRect({ ...placed, flipY: true })).toEqual({ h: 6, w: 32, x: 180, y: 70 });
  });

  it("follow an object's own path over its id's catalog sprite", () => {
    const fix = { id: "office-object-001", path: "workspace-kit/design2/d2-fix-0.png" };
    const placed = { ...fix, flipX: false, flipY: false, x: 10, y: 20 };
    expect(srcForObject(fix)).toBe(fix.path);
    expect(worldRect(placed)).toEqual({ h: 6, w: 2, x: 10, y: 20 });
  });

  it("put a placed sprite's content where the click lands and anchor it on its bottom", () => {
    const made = makeObject(rail.id, 100, 100, { path: rail.path });
    expect(worldRect(made)).toMatchObject({ x: 100, y: 100 });
    expect(made.layer === "object" ? made.anchorY : null).toBe(106);
    expect(objectSpritePath(made)).toBe(rail.path);
  });

  it("put a floor tile's canvas on the click, keeping it on the grid it was cut from", () => {
    const made = makeObject("rb-3-0", 32, 0, {
      layer: "floor",
      path: "workspace-kit/room-builder/32/tile-3-0.png",
    });
    expect(made).toMatchObject({ x: 32, y: 0 });
    expect(worldRect(made).x).toBe(50);
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

const rug = {
  flipX: false,
  flipY: false,
  id: "office-object-001",
  layer: "floor",
  uid: "rug",
  x: 0,
  y: 0,
} satisfies EditableObject;

describe("editing several objects at once", () => {
  const layout: EditableLayout = { ...loadLayout(), objects: [desk, rug] };
  const doc: BuilderDoc = { layout, selection: ["rug"] };

  it("moves exactly the named objects, floor lines with them", () => {
    const moved = moveObjects(layout, ["desk"], 8, -4);
    expect(moved.objects).toEqual([{ ...desk, anchorY: desk.anchorY - 4, x: 48, y: 56 }, rug]);
    expect(moved.objects[1]).toBe(rug);
  });

  it("copies the named objects in layout order under fresh uids, offset", () => {
    const copies = duplicates(layout, ["rug", "desk", "gone"], 8, 8);
    const [deskCopy, rugCopy, ...rest] = copies;
    expect(rest).toEqual([]);
    expect(deskCopy).toEqual({
      ...desk,
      anchorY: desk.anchorY + 8,
      uid: deskCopy?.uid,
      x: 48,
      y: 68,
    });
    expect(rugCopy).toEqual({ ...rug, uid: rugCopy?.uid, x: 8, y: 8 });
    expect(copies.filter((o) => o.uid === desk.uid || o.uid === rug.uid)).toEqual([]);
    expect(layout.objects).toEqual([desk, rug]);
  });

  it("puts objects down on top and selects exactly them", () => {
    const copies = duplicates(layout, ["desk"], 0, 0);
    const next = addSelected(doc, copies);
    expect(next.layout.objects).toEqual([desk, rug, ...copies]);
    expect(next.selection).toEqual(copies.map((o) => o.uid));
  });

  it("hands back the same doc when the layout did not change, so nothing is recorded", () => {
    expect(withLayout(doc, layout)).toBe(doc);
    expect(withLayout(doc, moveObjects(layout, ["desk"], 1, 0)).selection).toBe(doc.selection);
  });
});

const openedCells = (before: readonly string[], after: readonly string[]): string[] =>
  before.flatMap((row, r) =>
    [...row].flatMap((cell, c) => (cell === "1" && after[r]?.[c] === "0" ? [`${r},${c}`] : [])),
  );
const paint = (L: EditableLayout, c: number, r: number, val: 0 | 1): EditableLayout => ({
  ...L,
  collision: setCollisionCell(L.collision, L.cols, c, r, val),
});

describe("painting collision", () => {
  const doc: BuilderDoc = { layout: loadLayout(), selection: ["rug"] };

  it("changes the one cell and keeps the selection", () => {
    expect(doc.layout.collision[5]?.[5]).toBe("0");
    const painted = paintCell(doc, 5, 5, 1);
    expect(painted.layout.collision[5]?.[5]).toBe("1");
    expect(paintCell(painted, 5, 5, 0).layout.collision).toEqual(doc.layout.collision);
    expect(painted.selection).toBe(doc.selection);
  });

  it("hands back the same doc over a cell that already holds the value, or off the grid", () => {
    expect(doc.layout.collision[0]?.[0]).toBe("1");
    expect(paintCell(doc, 0, 0, 1)).toBe(doc);
    expect(paintCell(doc, -1, 0, 1)).toBe(doc);
    expect(paintCell(doc, doc.layout.cols, 0, 1)).toBe(doc);
    expect(paintCell(doc, 0, doc.layout.collision.length, 1)).toBe(doc);
  });
});

describe("sealing pockets", () => {
  const shipped = loadLayout();

  it("leaves the shipped office as authored, and saveable", () => {
    const sealed = sealPockets(shipped);
    expect(sealed).toEqual(shipped.collision);
    expect(layoutIssues(toLayoutData({ ...shipped, collision: sealed }))).toEqual([]);
  });

  it("closes open floor walled in where no body can reach it", () => {
    const pocketed = paint(shipped, 1, 1, 0);
    expect(sealPockets(pocketed)).toEqual(shipped.collision);
  });

  it("keeps painted collision, never opens a cell, and settles in one pass", () => {
    const blocked = paint(shipped, 10, 10, 1);
    const sealed = sealPockets(blocked);
    expect(sealed[10]?.[10]).toBe("1");
    expect(openedCells(blocked.collision, sealed)).toEqual([]);
    expect(sealPockets({ ...blocked, collision: sealed })).toEqual(sealed);
  });
});
