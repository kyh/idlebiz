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
import { OFFICE_OBJECT_ASSETS } from "@/renderer/game/office-object-catalog.generated";
import type { OfficeObjectAsset } from "@/renderer/game/office-object-catalog.generated";
import { ROOM_BUILDER_TILES } from "@/renderer/game/room-builder-tiles.generated";
import type { RoomBuilderTile } from "@/renderer/game/room-builder-tiles.generated";
import { sealedCollision } from "@/shared/office-grid";

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

const CATALOG = new Map<string, OfficeObjectAsset>(OFFICE_OBJECT_ASSETS.map((a) => [a.id, a]));
export const ALL_OBJECT_IDS: readonly string[] = OFFICE_OBJECT_ASSETS.map((a) => a.id);
export const ROOM_TILES: readonly RoomBuilderTile[] = ROOM_BUILDER_TILES;

const rawBounds = (id: string): { canvasW: number; canvasH: number; b: Rect } => {
  const v = CATALOG.get(id);
  // room-builder tiles are not in the catalog: full cell
  return v
    ? { b: v.bounds, canvasH: v.h, canvasW: v.w }
    : { b: { h: 32, w: 32, x: 0, y: 0 }, canvasH: 32, canvasW: 32 };
};
/** Canvas-local content bbox, adjusted for flips (flipping mirrors the content
 * inside its canvas box, so the bbox moves to the mirrored corner). */
const contentBounds = (o: Pick<EditableObject, "id" | "flipX" | "flipY">): Rect => {
  const { canvasW, canvasH, b } = rawBounds(o.id);
  return {
    h: b.h,
    w: b.w,
    x: o.flipX ? canvasW - (b.x + b.w) : b.x,
    y: o.flipY ? canvasH - (b.y + b.h) : b.y,
  };
};
type Placed = Pick<EditableObject, "id" | "x" | "y" | "flipX" | "flipY">;

/** Where the object's content sits in the world: what you see, hit and select. */
export const worldRect = (o: Placed): Rect => {
  const b = contentBounds(o);
  return { h: b.h, w: b.w, x: o.x + b.x, y: o.y + b.y };
};
/** y-sort anchor for an object placed at world y = bottom of its (flipped) content. */
const anchorFor = (o: Pick<EditableObject, "id" | "flipX" | "flipY">, y: number): number => {
  const b = contentBounds(o);
  return y + b.y + b.h;
};
export const assetSrc = (id: string): string | null => {
  const v = CATALOG.get(id);
  return v ? v.path : null;
};
/** Image src for a placed object — its explicit path (tiles) or its catalog sprite. */
export const srcForObject = (o: { id: string; path?: string }): string | null => {
  if (o.path) {
    return o.path;
  }
  return assetSrc(o.id);
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

/** Place by the sprite's CONTENT top-left at (cx, cy) — so the visible sprite lands
 * where you click, not offset by the transparent padding in its source image. */
export const makeObject = (
  id: string,
  cx: number,
  cy: number,
  opts: { path?: string; layer?: OfficeLayer } = {},
): EditableObject => {
  const layer = opts.layer ?? "object";
  const unflipped = { flipX: false, flipY: false, id };
  const b = contentBounds(unflipped);
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

export const cloneObject = (o: EditableObject): EditableObject => ({
  ...o,
  uid: crypto.randomUUID(),
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

/**
 * The authored grid with the walker's own rules written in: seat cells and open floor
 * no body can stand on close, exactly as `walkGridOf` closes them at load. It only
 * ever closes cells, so painted collision survives and a second run changes nothing.
 */
export const sealPockets = (L: EditableLayout): string[] => sealedCollision(L);
