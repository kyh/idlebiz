// The composited character sheet as geometry: which strip is which, where the
// origin and the soles sit, what a seated bust covers, and what its anims are
// called. No Phaser here, so the seat oracle and the movement math can be
// unit-tested; loading the sheet into a scene is characters.ts.
import { DEPTH } from "@/renderer/game/config";
import {
  CHAR_ORIGIN_X,
  CHAR_ORIGIN_Y,
  FRAME_H,
  FRAME_W,
  HEAD_ROW,
  SOLE_OFFSET,
  type Dir,
  type SitSide,
} from "@/shared/character-frame";

export { CHAR_ORIGIN_X, CHAR_ORIGIN_Y, type Dir, type SitSide };

// Six frames per row: walk down/left/right/up (rows 0-3), then sit-left (row 4)
// and sit-right (row 5).
export const DIR_START = { down: 0, left: 6, right: 12, up: 18 } satisfies Record<Dir, number>;
export const SIT_START = { left: 24, right: 30 } satisfies Record<SitSide, number>;

/** Depth of a character whose origin sits at world `y`. */
export function characterDepth(y: number): number {
  return DEPTH.entityBase + y + SOLE_OFFSET;
}

/** Standing frame index for a direction (first frame of that direction's strip). */
export const idleFrame = (dir: Dir): number => DIR_START[dir];

/**
 * The frame region drawn while seated. The pack's own seated workers are head-and-
 * shoulders busts painted over the chair with the desk in front; cropping the walk sheet
 * at the origin row reproduces that silhouette, so a sitter lifted above their desk
 * (seat-depth.ts) doesn't dangle legs across it.
 */
export const SEAT_CROP = {
  x: 0,
  y: 0,
  w: FRAME_W,
  h: Math.round(FRAME_H * CHAR_ORIGIN_Y),
} as const;

/** Silhouette of that bust around its origin — what a seat tests for overlap. */
export const BUST = {
  halfWidth: 10,
  height: Math.ceil(FRAME_H * CHAR_ORIGIN_Y) - HEAD_ROW,
} as const;

/** The animation keys of one character texture, so a walker never spells them per frame. */
export interface CharacterAnims {
  readonly walk: Readonly<Record<Dir, string>>;
  readonly sit: Readonly<Record<SitSide, string>>;
}

export function characterAnims(key: string): CharacterAnims {
  return {
    walk: {
      down: `${key}-walk-down`,
      left: `${key}-walk-left`,
      right: `${key}-walk-right`,
      up: `${key}-walk-up`,
    },
    sit: { left: `${key}-sit-left`, right: `${key}-sit-right` },
  };
}
