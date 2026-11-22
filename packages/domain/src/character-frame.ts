/** Frame size in px. */
export const FRAME_W = 32;
export const FRAME_H = 64;

/** Frames across a sheet, 1792 px wide. */
export const SHEET_COLUMNS = 56;

/** Frames in each walk or sit strip. */
export const STRIP_FRAMES = 6;

export const DIRS = ["down", "left", "right", "up"] as const;

export type Dir = (typeof DIRS)[number];

export const SIT_SIDES = ["left", "right"] as const;

export type SitSide = (typeof SIT_SIDES)[number];

const frameAt = (row: number, column: number) => row * SHEET_COLUMNS + column;

const WALK_ROW = 2;
const SIT_ROW = 4;

/** Each direction's walk strip by its first frame, the pose a character stands in. */
export const WALK_START = {
  down: frameAt(WALK_ROW, 18),
  left: frameAt(WALK_ROW, 12),
  right: frameAt(WALK_ROW, 0),
  up: frameAt(WALK_ROW, 6),
} satisfies Record<Dir, number>;

export const SIT_START = {
  left: frameAt(SIT_ROW, 0),
  right: frameAt(SIT_ROW, 6),
} satisfies Record<SitSide, number>;

/** One origin for every character, so the player and NPCs sort on the same footing. */
export const CHAR_ORIGIN_X = 0.5;
export const CHAR_ORIGIN_Y = 0.86;

/** Content rows within a frame: the art starts at the hair and ends at the soles. */
export const HEAD_ROW = 18;
const SOLE_ROW = 62;

export const SOLE_OFFSET = SOLE_ROW - FRAME_H * CHAR_ORIGIN_Y;
