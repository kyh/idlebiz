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
import type { PixelPoint } from "@/shared/office-layout-schema";

/** How far above their workstation a seated employee is lifted. */
const SEAT_LIFT = 0.25;

/** Opaque-pixel coverage of a room texture, in texture space. */
export interface OpaqueMask {
  readonly opaque: Uint8Array;
  readonly w: number;
  readonly h: number;
}

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
    const ly = image.flipY ? mask.h - 1 - dy : dy;
    if (ly < 0 || ly >= mask.h) continue;
    for (let x = rect.x0; x < rect.x1; x++) {
      const dx = Math.floor(x - image.x);
      const lx = image.flipX ? mask.w - 1 - dx : dx;
      if (lx < 0 || lx >= mask.w) continue;
      if (mask.opaque[ly * mask.w + lx]) return true;
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

function opaqueMaskOf(
  source: ReturnType<Phaser.Textures.Texture["getSourceImage"]>,
): OpaqueMask | null {
  if (!(source instanceof HTMLImageElement) && !(source instanceof HTMLCanvasElement)) return null;
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const opaque = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < opaque.length; i++) opaque[i] = (pixels[i * 4 + 3] ?? 0) > 0 ? 1 : 0;
  return { opaque, w: canvas.width, h: canvas.height };
}

/**
 * `seatDepth` over a built room's images, reading each texture back at most once — and
 * only the ones whose bounds reach a seat; the rest of the room is never decoded.
 */
export function seatDepthOracle(
  textures: Phaser.Textures.TextureManager,
): (seat: PixelPoint, room: readonly Phaser.GameObjects.Image[]) => number {
  const masks = new Map<string, OpaqueMask | null>();
  const maskOf = (image: Phaser.GameObjects.Image): OpaqueMask | null => {
    const key = image.texture.key;
    const cached = masks.get(key);
    if (cached !== undefined) return cached;
    const mask = opaqueMaskOf(textures.get(key).getSourceImage());
    masks.set(key, mask);
    return mask;
  };
  return (seat, room) => seatDepth(seat, room, maskOf);
}
