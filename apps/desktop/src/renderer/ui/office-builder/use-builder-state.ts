// State + (de)serialization for the in-app office builder (#/office-builder).
// Loads the current office-design.json, lets the user place catalog singles by
// hand, and serializes back to the exact schema the game reads — re-deriving the
// collision grid from the placed furniture so the result stays playable.
import {
  OFFICE_LAYOUT_RAW,
  depthFor,
  type OfficeLayer,
  type OfficeLayoutData,
} from "@/renderer/game/office-layout";
import {
  OFFICE_OBJECT_ASSETS,
  type OfficeObjectVariant,
} from "@/renderer/game/office-object-catalog.generated";
import { ROOM_BUILDER_TILES, type RoomBuilderTile } from "@/renderer/game/room-builder-tiles.generated";

export type Tool = "select" | "place" | "spawn" | "seat" | "block" | "clear";

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

/** A placed prop being edited. `uid`/`solid` are builder-only (not serialized). */
export interface EditableObject {
  uid: string;
  id: string;
  x: number;
  y: number;
  layer: OfficeLayer;
  anchorY: number;
  solid: boolean;
  flipX: boolean;
  flipY: boolean;
  path?: string; // explicit asset path (room-builder tiles); else resolved from id via the catalog
}

export interface EditableLayout {
  tile: number;
  width: number;
  height: number;
  cell: number;
  cols: number;
  rows: number;
  spawn: Pt;
  workSeats: Pt[];
  objects: EditableObject[];
  collision: string[]; // authored grid; preserved on save, re-derived on demand
}

const FOOT = 24; // collision footprint band (matches the layout generator)

// --- catalog (scale-32 variant) lookups -------------------------------------
const V32 = new Map<string, OfficeObjectVariant>();
for (const asset of OFFICE_OBJECT_ASSETS) {
  const v = asset.variants.find((variant) => variant.scale === 32);
  if (v) V32.set(asset.id, v);
}
export const ALL_OBJECT_IDS: readonly string[] = OFFICE_OBJECT_ASSETS.map((a) => a.id);
export const ROOM_TILES: readonly RoomBuilderTile[] = ROOM_BUILDER_TILES;

export function variant32(id: string): OfficeObjectVariant | null {
  return V32.get(id) ?? null;
}
function rawBounds(id: string): { canvasW: number; canvasH: number; b: Rect } {
  const v = V32.get(id);
  return v
    ? { canvasW: v.w, canvasH: v.h, b: v.bounds }
    : { canvasW: 32, canvasH: 32, b: { x: 0, y: 0, w: 32, h: 32 } }; // room-builder tiles: full cell
}
/** Canvas-local content bbox, adjusted for flips (flipping mirrors the content
 * inside its canvas box, so the bbox moves to the mirrored corner). */
export function contentBounds(o: Pick<EditableObject, "id" | "flipX" | "flipY">): Rect {
  const { canvasW, canvasH, b } = rawBounds(o.id);
  return {
    x: o.flipX ? canvasW - (b.x + b.w) : b.x,
    y: o.flipY ? canvasH - (b.y + b.h) : b.y,
    w: b.w,
    h: b.h,
  };
}
/** y-sort anchor for an object placed at world y = bottom of its (flipped) content. */
export function anchorFor(o: Pick<EditableObject, "id" | "flipX" | "flipY">, y: number): number {
  const b = contentBounds(o);
  return y + b.y + b.h;
}
export function assetSrc(id: string): string | null {
  const v = V32.get(id);
  return v ? `/${v.path}` : null;
}
/** Image src for a placed object — its explicit path (tiles) or its catalog sprite. */
export function srcForObject(o: { id: string; path?: string }): string | null {
  if (o.path) return `/${o.path}`;
  return assetSrc(o.id);
}
/** The render depth used by the game; the builder sorts by this for WYSIWYG. */
export function objectDepth(o: { layer: OfficeLayer; anchorY: number }): number {
  return depthFor(o.layer, o.anchorY);
}
function footprintRect(o: EditableObject): Rect | null {
  const b = contentBounds(o);
  // full content footprint (a solid desk blocks its whole base, matching the
  // generator); FOOT trims very tall sprites so a wall-mounted item that's
  // mis-flagged solid doesn't paint a huge column.
  const fh = Math.min(Math.max(FOOT, Math.round(b.h * 0.85)), b.h);
  return { x: o.x + b.x, y: o.y + b.y + b.h - fh, w: b.w, h: fh };
}

// Random uids: a module counter would reset on HMR while React state keeps
// the old uids, colliding new placements with loaded ones.
function newUid(): string {
  return crypto.randomUUID();
}

// --- grid helpers -----------------------------------------------------------
function paint(grid: number[][], cell: number, cols: number, rows: number, r: Rect, v: number): void {
  const c0 = Math.max(0, Math.floor(r.x / cell));
  const r0 = Math.max(0, Math.floor(r.y / cell));
  const c1 = Math.min(cols, Math.ceil((r.x + r.w) / cell));
  const r1 = Math.min(rows, Math.ceil((r.y + r.h) / cell));
  for (let rr = r0; rr < r1; rr++) for (let cc = c0; cc < c1; cc++) grid[rr][cc] = v;
}

// --- load -------------------------------------------------------------------
/** Build an editable layout from a parsed layout (the saved office, or the bundled default). */
export function loadLayout(raw: OfficeLayoutData = OFFICE_LAYOUT_RAW): EditableLayout {
  const r: OfficeLayoutData = raw;
  const grid = r.collision.map((row) => Array.from(row, (ch) => (ch === "1" ? 1 : 0)));
  const objects: EditableObject[] = r.objects.map((o) => ({
    uid: newUid(),
    id: o.id,
    x: o.x,
    y: o.y,
    layer: o.layer,
    anchorY: o.anchorY,
    solid: inferSolid(o, grid, r.cell),
    flipX: o.flipX ?? false,
    flipY: o.flipY ?? false,
    path: o.path,
  }));
  return {
    tile: r.tile,
    width: r.width,
    height: r.height,
    cell: r.cell,
    cols: r.cols,
    rows: r.rows,
    spawn: { x: r.spawn.x, y: r.spawn.y },
    workSeats: r.workSeats.map((s) => ({ x: s.x, y: s.y })),
    objects,
    collision: [...r.collision],
  };
}

/** An object loaded from disk is "solid" if its footprint cells are mostly solid. */
function inferSolid(
  o: { id: string; x: number; y: number; layer: OfficeLayer; flipX?: boolean; flipY?: boolean },
  grid: number[][],
  cell: number,
): boolean {
  if (o.layer !== "object" || !V32.has(o.id)) return false;
  const b = contentBounds({ id: o.id, flipX: o.flipX ?? false, flipY: o.flipY ?? false });
  const fh = Math.min(FOOT, b.h);
  const fp: Rect = { x: o.x + b.x, y: o.y + b.y + b.h - fh, w: b.w, h: fh };
  let solidCells = 0;
  let total = 0;
  const c0 = Math.floor(fp.x / cell);
  const r0 = Math.floor(fp.y / cell);
  const c1 = Math.ceil((fp.x + fp.w) / cell);
  const r1 = Math.ceil((fp.y + fp.h) / cell);
  for (let rr = r0; rr < r1; rr++)
    for (let cc = c0; cc < c1; cc++) {
      total += 1;
      if (grid[rr]?.[cc] === 1) solidCells += 1;
    }
  return total > 0 && solidCells * 2 >= total;
}

// --- serialize --------------------------------------------------------------
/** Re-derive the collision grid from the placed pieces: floor-layer tiles carve
 * walkable space, solid furniture paints back solid, seats stay reachable. */
export function deriveCollision(L: EditableLayout): string[] {
  const grid = Array.from({ length: L.rows }, () => Array.from({ length: L.cols }, () => 1));
  for (const o of L.objects) {
    if (o.layer !== "floor") continue;
    const v = V32.get(o.id);
    const b = v ? v.bounds : { x: 0, y: 0, w: 32, h: 32 };
    paint(grid, L.cell, L.cols, L.rows, { x: o.x + b.x, y: o.y + b.y, w: b.w, h: b.h }, 0);
  }
  for (const o of L.objects) {
    if (!o.solid) continue;
    const fp = footprintRect(o);
    if (fp) paint(grid, L.cell, L.cols, L.rows, fp, 1);
  }
  for (const s of L.workSeats) {
    const c = Math.floor(s.x / L.cell);
    const r = Math.floor(s.y / L.cell);
    if (r >= 0 && c >= 0 && r < L.rows && c < L.cols) grid[r][c] = 0;
  }
  return grid.map((row) => row.join(""));
}

/** Serialize to the exact office-design.json string the game reads. */
export function serializeLayout(L: EditableLayout): string {
  const objects = L.objects
    .toSorted((a, b) => objectDepth(a) - objectDepth(b))
    .map((o) => {
      const out: {
        id: string;
        x: number;
        y: number;
        layer: OfficeLayer;
        anchorY: number;
        path?: string;
        flipX?: boolean;
        flipY?: boolean;
      } = { id: o.id, x: o.x, y: o.y, layer: o.layer, anchorY: o.anchorY };
      if (o.path) out.path = o.path;
      if (o.flipX) out.flipX = true;
      if (o.flipY) out.flipY = true;
      return out;
    });
  const out = {
    tile: L.tile,
    width: L.width,
    height: L.height,
    cell: L.cell,
    cols: L.cols,
    rows: L.rows,
    spawn: L.spawn,
    objects,
    collision: L.collision,
    workSeats: L.workSeats,
  };
  return JSON.stringify(out);
}

/** Place by the sprite's CONTENT top-left at (cx, cy) — so the visible sprite lands
 * where you click, not offset by the transparent padding in its source image. */
export function makeObject(
  id: string,
  cx: number,
  cy: number,
  opts: { path?: string; layer?: OfficeLayer } = {},
): EditableObject {
  const layer = opts.layer ?? "object";
  const unflipped = { id, flipX: false, flipY: false };
  const b = contentBounds(unflipped);
  const x = cx - b.x;
  const y = cy - b.y;
  return {
    uid: newUid(),
    id,
    x,
    y,
    layer,
    anchorY: anchorFor(unflipped, y),
    solid: layer === "object" && !opts.path,
    flipX: false,
    flipY: false,
    path: opts.path,
  };
}

/** Duplicate a placed object (fresh uid). */
export function cloneObject(o: EditableObject): EditableObject {
  return { ...o, uid: newUid() };
}

/** Set one collision cell (1 = solid, 0 = walkable); returns a new collision array. */
export function setCollisionCell(collision: string[], cols: number, c: number, r: number, val: 0 | 1): string[] {
  const row = collision[r];
  if (r < 0 || c < 0 || c >= cols || !row || row[c] === String(val)) return collision;
  const next = row.slice(0, c) + String(val) + row.slice(c + 1);
  const out = collision.slice();
  out[r] = next;
  return out;
}
