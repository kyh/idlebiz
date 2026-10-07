// World constants. The office is placed objects (office-design.json) over a
// 16px collision grid for movement, seats, and pathfinding — the grid itself
// lives in office-grid.ts.
/** Camera zoom (follows the player). */
export const ZOOM = 2;
/** px/sec, pre-zoom. */
export const WALK_SPEED = 115;

export { DEPTH } from "@/renderer/game/office-depth";

export const COLORS = {
  bg: 0x14_16_1f,
} as const;
