// World constants. The office is placed objects (office-design.json) over an
// authored 16px collision grid for movement, seats, and pathfinding — the grid
// itself lives in shared/office-grid.ts.
/** Camera zoom (Pokémon-style, follows the player). */
export const ZOOM = 2;
/** px/sec, pre-zoom. */
export const WALK_SPEED = 115;

// The draw bands live in shared/ so the layout schema can bound floor lines by
// them; re-exported here so the scene keeps one import for its world constants.
export { DEPTH } from "@/shared/office-depth";

export const COLORS = {
  bg: 0x14_16_1f,
} as const;
