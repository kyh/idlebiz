// A character's sheet as the office draws it: the frame it stands in, where the origin and
// the soles sit, what a seated bust covers, and what its anims are called. Which frame is
// which is @repo/domain/character-frame. No Phaser here, so the seat oracle and the movement
// math can be unit-tested; loading the sheet into a scene is characters.ts.
import {
  CHAR_ORIGIN_Y,
  FRAME_H,
  FRAME_W,
  HEAD_ROW,
  WALK_START,
} from "@repo/domain/character-frame";
import type { Dir, SitSide } from "@repo/domain/character-frame";

export { CHAR_ORIGIN_X, CHAR_ORIGIN_Y, type Dir, type SitSide } from "@repo/domain/character-frame";

/** Standing frame index for a direction (first frame of that direction's strip). */
export const idleFrame = (dir: Dir): number => WALK_START[dir];

/**
 * The frame region drawn while seated. The pack's own seated workers are head-and-
 * shoulders busts painted over the chair with the desk in front; cropping the frame at
 * the origin row reproduces that silhouette, so a sitter lifted above their desk
 * (seat-depth.ts) doesn't dangle legs across it.
 */
export const SEAT_CROP = {
  h: Math.round(FRAME_H * CHAR_ORIGIN_Y),
  w: FRAME_W,
  x: 0,
  y: 0,
} as const;

/** The origin that draws a sprite `rise` px up the screen from where it stands. */
export const risenOriginY = (rise: number): number => CHAR_ORIGIN_Y + rise / FRAME_H;

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

export const characterAnims = (key: string): CharacterAnims => ({
  sit: { left: `${key}-sit-left`, right: `${key}-sit-right` },
  walk: {
    down: `${key}-walk-down`,
    left: `${key}-walk-left`,
    right: `${key}-walk-right`,
    up: `${key}-walk-up`,
  },
});
