// Where a seated employee draws relative to the furniture around them.
//
// The art pack paints its seated workers OVER the workstation — chair back behind the
// head, desk in front — and pure y-sorting cannot express that: a chair's floor contact
// is always SOUTH of whoever sits in it, so y-sort buries the sitter behind the chair.
// A seat is lifted just above the topmost thing its occupant's bust actually overlaps
// and no further, so a colleague walking past the front of the desk still occludes them.
import type Phaser from "phaser";
import { BUST, characterDepth } from "@/renderer/game/character-sheet";
import { DEPTH } from "@/renderer/game/config";
import type { OpaqueMask } from "@/renderer/game/texture-masks";
import type { PixelPoint } from "@/shared/office-layout-schema";
import { opaqueAt } from "@/shared/office-sight";

/** How far above their workstation a seated employee is lifted. */
const SEAT_LIFT = 0.25;

/** A placed room image as the seat test sees it: its bounds, band and flips. */
export interface RoomImage {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
}

interface PixelRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * The whole-pixel rect where a bust seated at `seat` and `image` overlap, or null when
 * their bounds don't meet — decided from bounds alone, before any texture is read.
 */
export function bustOverlapRect(seat: PixelPoint, image: RoomImage): PixelRect | null {
  const x0 = Math.floor(Math.max(seat.x - BUST.halfWidth, image.x));
  const x1 = Math.ceil(Math.min(seat.x + BUST.halfWidth, image.x + image.width));
  const y0 = Math.floor(Math.max(seat.y - BUST.height, image.y));
  const y1 = Math.ceil(Math.min(seat.y, image.y + image.height));
  return x1 <= x0 || y1 <= y0 ? null : { x0, y0, x1, y1 };
}

/**
 * Does a seated bust at `seat` touch any opaque pixel of `image`?
 *
 * Object canvases are heavily padded, so bounds alone would lift a seat above furniture
 * it never actually touches: only when the bounds meet is the texture consulted, through
 * `maskOf` — and a texture that cannot be read is assumed to cover, so the seat clears it.
 *
 * Walks the overlap rect in whole pixels: the mask is indexed arithmetically, and a
 * fractional or out-of-range index reads past the array as `undefined` — falsy, so a
 * miss. TS types a Uint8Array read as `number`, so nothing would flag that; keep every
 * index an integer inside the mask instead of trusting placements to stay aligned.
 */
export function bustOverlaps(
  seat: PixelPoint,
  image: RoomImage,
  maskOf: () => OpaqueMask | null,
): boolean {
  const rect = bustOverlapRect(seat, image);
  if (!rect) return false;
  const mask = maskOf();
  if (!mask) return true;
  for (let y = rect.y0; y < rect.y1; y++) {
    const dy = Math.floor(y - image.y);
    for (let x = rect.x0; x < rect.x1; x++) {
      if (opaqueAt(mask, image, Math.floor(x - image.x), dy)) return true;
    }
  }
  return false;
}

/**
 * Depth a seated employee renders at: just above the topmost entity-band image their
 * bust overlaps. Overhead props are meant to stay above actors, so a seat never lifts
 * past them.
 */
export function seatDepth<T extends RoomImage>(
  seat: PixelPoint,
  room: readonly T[],
  maskOf: (image: T) => OpaqueMask | null,
): number {
  let depth = characterDepth(seat.y);
  for (const image of room) {
    if (image.depth <= depth || image.depth >= DEPTH.overhead) continue;
    if (!bustOverlaps(seat, image, () => maskOf(image))) continue;
    depth = image.depth;
  }
  return depth + SEAT_LIFT;
}

/** `seatDepth` over a built room's images, reading only the textures whose bounds reach a seat. */
export function seatDepthOracle(
  maskOf: (key: string) => OpaqueMask | null,
): (seat: PixelPoint, room: readonly Phaser.GameObjects.Image[]) => number {
  return (seat, room) => seatDepth(seat, room, (image) => maskOf(image.texture.key));
}
