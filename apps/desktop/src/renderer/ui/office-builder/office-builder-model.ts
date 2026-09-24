import { BUNDLED_LAYOUT, comparePaintOrder } from "@/renderer/game/office-layout";
import type {
  OfficeLayer,
  OfficeLayoutData,
  OfficePoi,
  OfficeSeat,
} from "@/renderer/game/office-layout";
import {
  OFFICE_LAYOUT_VERSION,
  canonicalOfficeLayout,
  cloneSeat,
  clonePoi,
} from "@/shared/office-layout-schema";
import type { OfficeObjectDef } from "@/shared/office-layout-schema";
import {
  OFFICE_OBJECT_ASSETS,
  objectSpritePath,
  spriteBounds,
} from "@/shared/office-object-sprite";
import { ROOM_BUILDER_TILES } from "@/renderer/game/room-builder-tiles.generated";
import type { RoomBuilderTile } from "@/renderer/game/room-builder-tiles.generated";
import { sealedCollision } from "@/shared/office-grid";
import type { GridCell } from "@/shared/office-grid";

export type Tool =
  | "select"
  | "place"
  | "spawn"
  | "door"
  | "seat"
  | "rest"
  | "poi"
  | "block"
  | "clear";

interface Pt {
  x: number;
  y: number;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A placed prop being edited. `uid` is builder-only (not serialized).
 *
 * Mirrors the game's model: the flat bands stack in list order, so only an
 * `object` carries the floor line that walkers y-sort against.
 */
interface EditableBase {
  uid: string;
  id: string;
  x: number;
  y: number;
  flipX: boolean;
  flipY: boolean;
  /** Explicit asset path (room-builder tiles); else resolved from id via the catalog. */
  path?: string;
}
export type EditableObject = EditableBase &
  ({ layer: "floor" } | { layer: "overhead" } | { layer: "object"; anchorY: number });
type YSorted = Extract<EditableObject, { layer: "object" }>;

/** The document under edit: the layout and which of its objects are selected. */
export interface BuilderDoc {
  layout: EditableLayout;
  selection: readonly string[];
}

export interface EditableLayout {
  tile: number;
  width: number;
  height: number;
  cell: number;
  cols: number;
  rows: number;
  spawn: Pt;
  /** Where hires walk in from and released employees walk out to. */
  door: Pt;
  seats: OfficeSeat[];
  pois: OfficePoi[];
  objects: EditableObject[];
  /** Authored grid, painted with the block/clear brushes: the only source of walkability. */
  collision: string[];
}

export const ALL_OBJECT_IDS: readonly string[] = OFFICE_OBJECT_ASSETS.map((a) => a.id);
export const ROOM_TILES: readonly RoomBuilderTile[] = ROOM_BUILDER_TILES;

type Sprite = Pick<EditableObject, "id" | "path" | "flipX" | "flipY">;

/** Canvas-local content bbox of the PNG the scene draws, adjusted for flips (flipping
 * mirrors the content inside its canvas box, so the bbox moves to the mirrored corner). */
const contentBounds = (o: Sprite): Rect => {
  const { w, h, bounds: b } = spriteBounds(objectSpritePath(o));
  return {
    h: b.h,
    w: b.w,
    x: o.flipX ? w - (b.x + b.w) : b.x,
    y: o.flipY ? h - (b.y + b.h) : b.y,
  };
};
type Placed = Pick<EditableObject, "id" | "path" | "x" | "y" | "flipX" | "flipY">;

/** Where the object's content sits in the world: what you see, hit and select. */
export const worldRect = (o: Placed): Rect => {
  const b = contentBounds(o);
  return { h: b.h, w: b.w, x: o.x + b.x, y: o.y + b.y };
};
/** y-sort anchor for an object placed at world y = bottom of its (flipped) content. */
const anchorFor = (o: Sprite, y: number): number => {
  const b = contentBounds(o);
  return y + b.y + b.h;
};
/**
 * The objects in the order the game paints them, back to front — what the builder
 * renders and what it serializes. Sorts by the game's own comparator, so the builder
 * cannot disagree with the scene about what covers what.
 */
export const paintOrder = (objects: readonly EditableObject[]): EditableObject[] =>
  objects.toSorted(comparePaintOrder);

/** The CSS transform that mirrors a sprite the way the game draws its flips. */
export const flipTransform = (o: Pick<EditableObject, "flipX" | "flipY">): string | undefined =>
  o.flipX || o.flipY ? `scale(${o.flipX ? -1 : 1}, ${o.flipY ? -1 : 1})` : undefined;

/** Move an object, keeping the floor line it y-sorts on in step with its sprite. */
export const moveObject = (o: EditableObject, x: number, y: number): EditableObject => {
  if (o.layer !== "object") {
    return { ...o, x, y };
  }
  return { ...o, anchorY: o.anchorY + (y - o.y), x, y };
};

/** Flip an object; a vertical flip moves its content bottom, so the anchor moves by as much. */
export const flipObject = (o: EditableObject, axis: "x" | "y"): EditableObject => {
  const flipped: EditableObject =
    axis === "x" ? { ...o, flipX: !o.flipX } : { ...o, flipY: !o.flipY };
  if (axis === "x" || flipped.layer !== "object") {
    return flipped;
  }
  const shift = anchorFor(flipped, flipped.y) - anchorFor(o, o.y);
  return { ...flipped, anchorY: flipped.anchorY + shift };
};

/**
 * Snap the floor line back to the bottom of the sprite's content. The one explicit
 * recompute: moves and flips carry an authored anchor along instead.
 */
export const autoAnchor = (o: YSorted): YSorted => ({ ...o, anchorY: anchorFor(o, o.y) });

/** Move an object to another band, giving it an anchor exactly when it needs one. */
export const setLayer = (o: EditableObject, layer: OfficeLayer): EditableObject => {
  if (o.layer === layer) {
    return o;
  }
  const { uid, id, x, y, flipX, flipY, path } = o;
  const base = { flipX, flipY, id, path, uid, x, y };
  return layer === "object" ? { ...base, anchorY: anchorFor(o, y), layer } : { ...base, layer };
};

// --- load -------------------------------------------------------------------
/** Build an editable layout from a parsed layout (the saved office, or the bundled default). */
export const loadLayout = (raw: OfficeLayoutData = BUNDLED_LAYOUT): EditableLayout => {
  const objects: EditableObject[] = raw.objects.map((o) => {
    const base = {
      flipX: o.flipX ?? false,
      flipY: o.flipY ?? false,
      id: o.id,
      path: o.path,
      uid: crypto.randomUUID(),
      x: o.x,
      y: o.y,
    };
    return o.layer === "object"
      ? { ...base, anchorY: o.anchorY, layer: o.layer }
      : { ...base, layer: o.layer };
  });
  return {
    cell: raw.cell,
    collision: [...raw.collision],
    cols: raw.cols,
    door: { x: raw.door.x, y: raw.door.y },
    height: raw.height,
    objects,
    pois: raw.pois.map(clonePoi),
    rows: raw.rows,
    seats: raw.seats.map(cloneSeat),
    spawn: { x: raw.spawn.x, y: raw.spawn.y },
    tile: raw.tile,
    width: raw.width,
  };
};

// --- serialize --------------------------------------------------------------
/** One object row as the game reads it, builder-only fields dropped; the canonicaliser tidies the keys. */
const toObjectDef = (o: EditableObject): OfficeObjectDef => {
  const placed = { flipX: o.flipX, flipY: o.flipY, id: o.id, path: o.path, x: o.x, y: o.y };
  return o.layer === "object"
    ? { ...placed, anchorY: o.anchorY, layer: "object" }
    : { ...placed, layer: o.layer };
};

/** The layout as the game reads it. Runs the same canonicaliser main writes with. */
export const toLayoutData = (L: EditableLayout): OfficeLayoutData => {
  // paint order is load-bearing on disk: the flat bands have no depth of their
  // own, so the array order IS their draw order
  const objects = paintOrder(L.objects).map(toObjectDef);
  return canonicalOfficeLayout({
    cell: L.cell,
    collision: L.collision,
    cols: L.cols,
    door: L.door,
    height: L.height,
    objects,
    pois: L.pois,
    rows: L.rows,
    seats: L.seats,
    spawn: L.spawn,
    tile: L.tile,
    version: OFFICE_LAYOUT_VERSION,
    width: L.width,
  });
};

/** Place a prop by its CONTENT top-left at (cx, cy) — so the visible sprite lands
 * where you click, not offset by the transparent padding in its source image. A floor
 * tile is placed by its canvas instead. */
export const makeObject = (
  id: string,
  cx: number,
  cy: number,
  opts: { path?: string; layer?: OfficeLayer } = {},
): EditableObject => {
  const layer = opts.layer ?? "object";
  const unflipped = { flipX: false, flipY: false, id, path: opts.path };
  // tiles are cut from a 32px grid and must land on it, whatever their opaque part
  const b = layer === "floor" ? { x: 0, y: 0 } : contentBounds(unflipped);
  const x = cx - b.x;
  const y = cy - b.y;
  const base = {
    flipX: false,
    flipY: false,
    id,
    path: opts.path,
    uid: crypto.randomUUID(),
    x,
    y,
  };
  return layer === "object"
    ? { ...base, anchorY: anchorFor(unflipped, y), layer }
    : { ...base, layer };
};

const cloneObject = (o: EditableObject): EditableObject => ({
  ...o,
  uid: crypto.randomUUID(),
});

/** The doc with this layout; the same doc when nothing changed, so a no-op commit records nothing. */
export const withLayout = (d: BuilderDoc, layout: EditableLayout): BuilderDoc =>
  layout === d.layout ? d : { ...d, layout };

/** The doc with this selection; the same doc when it already selects exactly these, in order. */
export const withSelection = (d: BuilderDoc, selection: readonly string[]): BuilderDoc =>
  selection.length === d.selection.length && selection.every((uid, i) => uid === d.selection[i])
    ? d
    : { ...d, selection };

/** Shift the named objects together; each keeps its floor line in step. The same layout when none moves. */
export const moveObjects = (
  L: EditableLayout,
  uids: readonly string[],
  dx: number,
  dy: number,
): EditableLayout => {
  const moving = new Set(uids);
  if ((dx === 0 && dy === 0) || !L.objects.some((o) => moving.has(o.uid))) {
    return L;
  }
  return {
    ...L,
    objects: L.objects.map((o) => (moving.has(o.uid) ? moveObject(o, o.x + dx, o.y + dy) : o)),
  };
};

/** Fresh copies of the named objects, offset by (dx, dy): what ⌘D and ⌥drag put down. */
export const duplicates = (
  L: EditableLayout,
  uids: readonly string[],
  dx: number,
  dy: number,
): EditableObject[] => {
  const src = new Set(uids);
  return L.objects
    .filter((o) => src.has(o.uid))
    .map((o) => moveObject(cloneObject(o), o.x + dx, o.y + dy));
};

/** Put objects down and select exactly them: a placement, a duplicate, an ⌥drag. */
export const addSelected = (d: BuilderDoc, objects: readonly EditableObject[]): BuilderDoc => ({
  layout: { ...d.layout, objects: [...d.layout.objects, ...objects] },
  selection: objects.map((o) => o.uid),
});

/** Set one collision cell (1 = solid, 0 = walkable); returns a new collision array. */
export const setCollisionCell = (
  collision: string[],
  cols: number,
  c: number,
  r: number,
  val: 0 | 1,
): string[] => {
  const row = collision[r];
  if (r < 0 || c < 0 || c >= cols || !row || row[c] === String(val)) {
    return collision;
  }
  const next = row.slice(0, c) + String(val) + row.slice(c + 1);
  const out = [...collision];
  out[r] = next;
  return out;
};

/** One brush step; the same doc when the cell already holds `val` or lies off the grid. */
export const paintCell = (d: BuilderDoc, c: number, r: number, val: 0 | 1): BuilderDoc => {
  const collision = setCollisionCell(d.layout.collision, d.layout.cols, c, r, val);
  return collision === d.layout.collision ? d : withLayout(d, { ...d.layout, collision });
};

/** Every collision cell a world rect touches, clipped to the grid. */
const cellsUnder = (L: EditableLayout, rect: Rect): GridCell[] => {
  const c0 = Math.max(0, Math.floor(rect.x / L.cell));
  const r0 = Math.max(0, Math.floor(rect.y / L.cell));
  const c1 = Math.min(L.cols, Math.ceil((rect.x + rect.w) / L.cell));
  const r1 = Math.min(L.rows, Math.ceil((rect.y + rect.h) / L.cell));
  const cells: GridCell[] = [];
  for (let r = r0; r < r1; r += 1) {
    for (let c = c0; c < c1; c += 1) {
      cells.push({ c, r });
    }
  }
  return cells;
};

/**
 * Close every cell a selected y-sorted object's art touches, so no walker stands inside it.
 * The whole art, not a guessed floor depth: a sprite does not say how deep its piece is,
 * and the overlay shows what closed for the clear brush to reopen. The flat bands have no
 * footprint, since walkers cross the floor band and pass under the overhead one. Only ever
 * closes cells; the same doc when all of them are already solid.
 */
export const blockFootprint = (d: BuilderDoc): BuilderDoc => {
  const picked = new Set(d.selection);
  const L = d.layout;
  let { collision } = L;
  for (const o of L.objects) {
    if (o.layer === "object" && picked.has(o.uid)) {
      for (const { r, c } of cellsUnder(L, worldRect(o))) {
        collision = setCollisionCell(collision, L.cols, c, r, 1);
      }
    }
  }
  return collision === L.collision ? d : withLayout(d, { ...L, collision });
};

/**
 * The authored grid with the walker's own rules written in: seat cells and open floor
 * no body can stand on close, exactly as `walkGridOf` closes them at load. It only
 * ever closes cells, so painted collision survives and a second run changes nothing.
 */
export const sealPockets = (L: EditableLayout): string[] => sealedCollision(L);
