// Shared by the compositor, scene, layout bounds and visibility checks.

/** Frame size in px. Six frames per row on the composited walk sheet. */
export const FRAME_W = 32;
export const FRAME_H = 64;

// Sight is judged by the standing pose, walk-down's first frame. A source employee sheet
// holds it in its walk band (y 128, down in columns 18-23); the compositor moves it to
// the walk sheet's top-left, where the scene reads it.
export const SOURCE_STANDING_FRAME = { x: 18 * FRAME_W, y: 128 } as const;
export const WALK_STANDING_FRAME = { x: 0, y: 0 } as const;

/** One origin for every character, so the player and NPCs sort on the same footing. */
export const CHAR_ORIGIN_X = 0.5;
export const CHAR_ORIGIN_Y = 0.86;

export const DIRS = ["down", "left", "right", "up"] as const;
export type Dir = (typeof DIRS)[number];
export const SIT_SIDES = ["left", "right"] as const;
export type SitSide = (typeof SIT_SIDES)[number];

/** Content rows within a frame: the art starts at the hair and ends at the soles. */
export const HEAD_ROW = 18;
const SOLE_ROW = 62;

// Furniture sorts on floor contact. Offset characters from their origin to their soles
// so desks do not paint over their feet during the last ~7px of approach.
export const SOLE_OFFSET = SOLE_ROW - FRAME_H * CHAR_ORIGIN_Y;
