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

// The scene seals standing spots where furniture hides the founder's face.
// check:office uses the same judgement with PNG masks instead of Phaser textures.

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

/** Probe sprite-local pixels. Flips mirror within the canvas; off-canvas is transparent. */
export function opaqueAt(
  mask: OpaqueMask,
  flip: { readonly flipX?: boolean; readonly flipY?: boolean },
  dx: number,
  dy: number,
): boolean {
  if (dx < 0 || dy < 0 || dx >= mask.w || dy >= mask.h) return false;
  const lx = flip.flipX ? mask.w - 1 - dx : dx;
  const ly = flip.flipY ? mask.h - 1 - dy : dy;
  return mask.opaque[ly * mask.w + lx] === 1;
}

/** Is the sprite's pixel at world (wx, wy) opaque? */
const paintsAt = ({ obj, mask }: PaintedSprite, wx: number, wy: number): boolean =>
  opaqueAt(mask, obj, wx - Math.round(obj.x), wy - Math.round(obj.y));

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
  const candidates = sprites.filter(({ obj }) => obj.layer !== "floor");
  for (const node of reachableNodes(grid, spawn)) {
    const covered = faceCovered(node, candidates, silhouette);
    if (covered >= FACE_HIDDEN_AT) hidden.push({ node, covered });
  }
  return hidden.toSorted((a, b) => b.covered - a.covered);
}
