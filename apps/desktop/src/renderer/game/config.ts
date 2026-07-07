// World constants. The office is placed objects (office-design.json) over an
// authored 16px collision grid for movement, seats, and pathfinding.
export const TILE = 32; // tile + sprite grid
export const ZOOM = 2; // camera zoom (Pokémon-style, follows the player)
export const WALK_SPEED = 115; // px/sec (pre-zoom)

export const DEPTH = {
  ground: 0, // floor
  entityBase: 1000, // + sprite bottom-y for y-sorting furniture/players/npcs
  emote: 2_000_000,
} as const;

export const COLORS = {
  bg: 0x14161f,
} as const;
