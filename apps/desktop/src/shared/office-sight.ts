import {
  CHAR_ORIGIN_X,
  CHAR_ORIGIN_Y,
  FRAME_H,
  FRAME_W,
  HEAD_ROW,
  SOLE_OFFSET,
} from "./character-frame.ts";
import { reachableNodes, type WalkGrid } from "./office-grid.ts";
import type { OfficeObjectDef, PixelPoint } from "./office-layout-schema.ts";

// ---------------------------------------------------------------------------
// Can the founder be seen where they can stand?
//
// Characters y-sort on their soles and furniture on its floor line, so standing
// north of a desk puts your legs behind it — right. Standing where something
// drawn above you covers your FACE is not: the lane behind a bookshelf, the
// floor under a plant's canopy, an overhead prop over a corridor. This judges
// that from the same masks the room is painted with; the scene runs it over
// Phaser's textures at boot and seals what it finds, check:office runs it over
// the PNGs so the bundled data never ships with any.
// ---------------------------------------------------------------------------

/** Opaque-pixel coverage of a sprite, in its own pixel space. */
export interface OpaqueMask {
  readonly opaque: Uint8Array;
  readonly w: number;
  readonly h: number;
}

/** A placed sprite and the pixels it paints. */
export interface PaintedSprite {
  readonly obj: OfficeObjectDef;
  readonly mask: OpaqueMask;
}

/** The rows a founder recognises a character by. Hidden face = not seen. */
const FACE_ROWS = 18;
/** How much of the face may be covered before the spot counts as hidden. */
const FACE_HIDDEN_AT = 0.5;

/** Does the scene draw this sprite above a character whose soles are at `soles`? */
const drawsAbove = (obj: OfficeObjectDef, soles: number): boolean =>
  obj.layer === "overhead" || (obj.layer === "object" && obj.anchorY + 0.5 > soles);

/** Is the sprite's pixel at world (wx, wy) opaque? Flips mirror in place, like setFlip. */
function paintsAt(sprite: PaintedSprite, wx: number, wy: number): boolean {
  const { obj, mask } = sprite;
  const dx = wx - Math.round(obj.x);
  const dy = wy - Math.round(obj.y);
  if (dx < 0 || dy < 0 || dx >= mask.w || dy >= mask.h) return false;
  const lx = obj.flipX ? mask.w - 1 - dx : dx;
  const ly = obj.flipY ? mask.h - 1 - dy : dy;
  return mask.opaque[ly * mask.w + lx] === 1;
}

/**
 * Fraction of the character's face painted over when their origin is at `node`.
 * `silhouette` is the standing frame: which of its pixels are the character at all.
 */
export function faceCovered(
  node: PixelPoint,
  sprites: readonly PaintedSprite[],
  silhouette: OpaqueMask,
): number {
  const left = Math.round(node.x - FRAME_W * CHAR_ORIGIN_X);
  const top = Math.round(node.y - FRAME_H * CHAR_ORIGIN_Y);
  const soles = node.y + SOLE_OFFSET;
  const faceTop = top + HEAD_ROW;
  const faceBottom = faceTop + FACE_ROWS;
  // only sprites drawn above the character whose canvas reaches the face
  const above = sprites.filter(
    ({ obj, mask }) =>
      drawsAbove(obj, soles) &&
      obj.x < left + FRAME_W &&
      obj.x + mask.w > left &&
      obj.y < faceBottom &&
      obj.y + mask.h > faceTop,
  );
  let face = 0;
  let hidden = 0;
  for (let y = HEAD_ROW; y < HEAD_ROW + FACE_ROWS; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      if (!silhouette.opaque[y * silhouette.w + x]) continue;
      face++;
      const wx = left + x;
      const wy = top + y;
      if (above.some((sprite) => paintsAt(sprite, wx, wy))) hidden++;
    }
  }
  return face === 0 ? 0 : hidden / face;
}

/** Every reachable node where the character's face would be hidden, worst first. */
export function hiddenNodes(
  grid: WalkGrid,
  spawn: PixelPoint,
  sprites: readonly PaintedSprite[],
  silhouette: OpaqueMask,
): { node: PixelPoint; covered: number }[] {
  const hidden: { node: PixelPoint; covered: number }[] = [];
  for (const node of reachableNodes(grid, spawn)) {
    const covered = faceCovered(node, sprites, silhouette);
    if (covered >= FACE_HIDDEN_AT) hidden.push({ node, covered });
  }
  return hidden.toSorted((a, b) => b.covered - a.covered);
}
