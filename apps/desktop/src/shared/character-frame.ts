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
