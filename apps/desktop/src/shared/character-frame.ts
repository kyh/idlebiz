// The character frame box, shared by everything that slices or places a sprite:
// the compositor (main) cuts frames from the pack sheets to this size, the scene
// (renderer) sets the origin from it, the layout schema reserves a frame height
// at the top of the entity band, and check:office walks the silhouette over the
// room. One declaration, so none of them can drift.

/** Frame size in px. Six frames per row on the composited walk sheet. */
export const FRAME_W = 32;
export const FRAME_H = 64;

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

/**
 * Gap between a character's depth anchor (its origin) and its soles. Office objects
 * anchor on their content bottom — their floor contact — so characters must be compared
 * on floor contact too. Without this a character renders BEHIND everything for the last
 * ~7px of approach, i.e. their feet get eaten right where they step in front of a desk.
 */
export const SOLE_OFFSET = SOLE_ROW - FRAME_H * CHAR_ORIGIN_Y;
