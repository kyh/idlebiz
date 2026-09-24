import { CHAR_ORIGIN_X, CHAR_ORIGIN_Y, FRAME_H, FRAME_W, HEAD_ROW } from "./character-frame.ts";
import { characterDepth, objectDepth } from "./office-depth.ts";
import {
  authoredGrid,
  closedAt,
  reachableNodes,
  spawnIssue,
  unreachablePlaces,
  walkGridOf,
  withoutNodes,
} from "./office-grid.ts";
import type { WalkGrid } from "./office-grid.ts";
import type { OfficeLayoutData, OfficeObjectDef, PixelPoint } from "./office-layout-schema.ts";
import { objectSpritePath } from "./office-object-sprite.ts";

// The scene seals standing spots where furniture hides the founder's face. The save
// handler and check:office use the same judgement with PNG masks instead of Phaser
// textures: main refuses a layout that seal cuts off or closes around the spawn, the
// gate any hidden spot at all.

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

/** Decoded pixels, four bytes each with alpha last: sharp's raw RGBA and a canvas's ImageData alike. */
export interface DecodedImage {
  readonly data: ArrayLike<number>;
  readonly w: number;
  readonly h: number;
}

/** Opaque-pixel coverage of a decoded image: any alpha at all is paint. */
export const opaqueMask = ({ data, w, h }: DecodedImage): OpaqueMask => {
  const opaque = new Uint8Array(w * h);
  for (let i = 0; i < opaque.length; i += 1) {
    opaque[i] = (data[i * 4 + 3] ?? 0) > 0 ? 1 : 0;
  }
  return { h, opaque, w };
};

/**
 * The standing pose's opaque pixels, cut from `sheet` at `frame`: WALK_STANDING_FRAME on
 * the walk sheet the scene draws, SOURCE_STANDING_FRAME on a source employee sheet.
 */
export const standingSilhouette = (sheet: OpaqueMask, frame: PixelPoint): OpaqueMask => {
  const opaque = new Uint8Array(FRAME_W * FRAME_H);
  for (let y = 0; y < FRAME_H; y += 1) {
    for (let x = 0; x < FRAME_W; x += 1) {
      opaque[y * FRAME_W + x] = sheet.opaque[(frame.y + y) * sheet.w + frame.x + x] ?? 0;
    }
  }
  return { h: FRAME_H, opaque, w: FRAME_W };
};

/** Each placed object with the mask of the PNG it draws; `decode` runs once per PNG. */
export const paintedSprites = (
  layout: Pick<OfficeLayoutData, "objects">,
  decode: (spritePath: string) => Promise<OpaqueMask>,
): Promise<PaintedSprite[]> => {
  const masks = new Map<string, Promise<OpaqueMask>>();
  const maskOf = (spritePath: string): Promise<OpaqueMask> => {
    let mask = masks.get(spritePath);
    if (!mask) {
      mask = decode(spritePath);
      masks.set(spritePath, mask);
    }
    return mask;
  };
  return Promise.all(
    layout.objects.map(async (obj) => ({ mask: await maskOf(objectSpritePath(obj)), obj })),
  );
};

/** The rows a founder recognises a character by. Hidden face = not seen. */
const FACE_ROWS = 18;
/** How much of the face may be covered before the spot counts as hidden. */
const FACE_HIDDEN_AT = 0.5;

/** Does the scene draw this sprite above a character whose origin is at world `y`? */
const drawsAbove = (obj: OfficeObjectDef, y: number): boolean =>
  obj.layer === "overhead" ||
  (obj.layer === "object" && objectDepth(obj.anchorY) > characterDepth(y));

/** Probe sprite-local pixels. Flips mirror within the canvas; off-canvas is transparent. */
export const opaqueAt = (
  mask: OpaqueMask,
  flip: { readonly flipX?: boolean; readonly flipY?: boolean },
  dx: number,
  dy: number,
): boolean => {
  if (dx < 0 || dy < 0 || dx >= mask.w || dy >= mask.h) {
    return false;
  }
  const lx = flip.flipX ? mask.w - 1 - dx : dx;
  const ly = flip.flipY ? mask.h - 1 - dy : dy;
  return mask.opaque[ly * mask.w + lx] === 1;
};

/** Is the sprite's pixel at world (wx, wy) opaque? */
const paintsAt = ({ obj, mask }: PaintedSprite, wx: number, wy: number): boolean =>
  opaqueAt(mask, obj, wx - Math.round(obj.x), wy - Math.round(obj.y));

/**
 * Fraction of the character's face painted over when their origin is at `node`.
 * `silhouette` is the standing frame: which of its pixels are the character at all.
 */
export const faceCovered = (
  node: PixelPoint,
  sprites: readonly PaintedSprite[],
  silhouette: OpaqueMask,
): number => {
  const left = Math.round(node.x - FRAME_W * CHAR_ORIGIN_X);
  const top = Math.round(node.y - FRAME_H * CHAR_ORIGIN_Y);
  const faceTop = top + HEAD_ROW;
  const faceBottom = faceTop + FACE_ROWS;
  // only sprites drawn above the character whose canvas reaches the face
  const above = sprites.filter(
    ({ obj, mask }) =>
      drawsAbove(obj, node.y) &&
      obj.x < left + FRAME_W &&
      obj.x + mask.w > left &&
      obj.y < faceBottom &&
      obj.y + mask.h > faceTop,
  );
  let face = 0;
  let hidden = 0;
  for (let y = HEAD_ROW; y < HEAD_ROW + FACE_ROWS; y += 1) {
    for (let x = 0; x < FRAME_W; x += 1) {
      if (!silhouette.opaque[y * silhouette.w + x]) {
        continue;
      }
      face += 1;
      const wx = left + x;
      const wy = top + y;
      if (above.some((sprite) => paintsAt(sprite, wx, wy))) {
        hidden += 1;
      }
    }
  }
  return face === 0 ? 0 : hidden / face;
};

/** Every reachable node where the character's face would be hidden, worst first. */
export const hiddenNodes = (
  grid: WalkGrid,
  spawn: PixelPoint,
  sprites: readonly PaintedSprite[],
  silhouette: OpaqueMask,
): { node: PixelPoint; covered: number }[] => {
  const hidden: { node: PixelPoint; covered: number }[] = [];
  const candidates = sprites.filter(({ obj }) => obj.layer !== "floor");
  for (const node of reachableNodes(grid, spawn)) {
    const covered = faceCovered(node, candidates, silhouette);
    if (covered >= FACE_HIDDEN_AT) {
      hidden.push({ covered, node });
    }
  }
  return hidden.toSorted((a, b) => b.covered - a.covered);
};

/** The walk grid with every reachable spot where the founder's face would be hidden closed. */
export const sightSealedGrid = (
  grid: WalkGrid,
  spawn: PixelPoint,
  sprites: readonly PaintedSprite[],
  silhouette: OpaqueMask,
): WalkGrid =>
  withoutNodes(
    grid,
    spawn,
    hiddenNodes(grid, spawn, sprites, silhouette).map((h) => h.node),
  );

/**
 * What closing the layout's hidden spots breaks: a spawn the founder cannot step from,
 * else the places it sends people that are cut off from spawn. A hidden spot alone is
 * no issue: the scene closes it at boot and walks around it.
 */
export const sightIssues = (
  layout: OfficeLayoutData,
  sprites: readonly PaintedSprite[],
  silhouette: OpaqueMask,
): string[] => {
  const hidden = hiddenNodes(walkGridOf(layout), layout.spawn, sprites, silhouette);
  // judged unsealed, as layoutIssues is: once a cut-off room is sealed solid its seat
  // snaps to floor on the reachable side of the closure and passes
  const closed = closedAt(
    authoredGrid(layout),
    hidden.map((h) => h.node),
  );
  const stuck = spawnIssue(layout, closed);
  return (stuck ? [stuck] : unreachablePlaces(layout, closed)).map(
    (issue) => `${issue} once the spots where furniture hides a face are closed`,
  );
};
