// World constants. The office is COMPOSED from individual Limezu furniture
// sprites (assets/office3/) rather than one baked image — so chairs/desks are
// real y-sorted objects (chairs occlude + are walk-through) and the room can
// grow in tiers as the startup hires.
export const TILE = 32; // tile + sprite grid (Limezu 32px tier)
export const ZOOM = 2.6; // camera zoom (Pokémon-style, follows the player)
export const WALK_SPEED = 115; // px/sec (pre-zoom)

export const DEPTH = {
  ground: 0, // floor
  wall: 5, // walls (drawn above floor, below entities so entities pass in front of side walls)
  entityBase: 1000, // + sprite bottom-y for y-sorting furniture/players/npcs
  emote: 2_000_000,
  ui: 3_000_000,
} as const;

export const COLORS = {
  bg: 0x14161f,
} as const;

export type FloorKind = "carpet" | "tile" | "wood";

/** A desk: top-left tile of a 2-wide desk. The chair/seat sits one+ tile below it. */
interface DeskSpec {
  readonly tx: number;
  readonly ty: number;
}
interface PlantSpec {
  readonly tx: number;
  readonly ty: number;
}

/** One office stage. The room grows (more desks, bigger room) as headcount rises. */
export interface OfficeTier {
  readonly cols: number; // room width in tiles (incl. walls)
  readonly rows: number; // room height in tiles (incl. walls)
  readonly floor: FloorKind;
  readonly desks: ReadonlyArray<DeskSpec>;
  readonly plants: ReadonlyArray<PlantSpec>;
  readonly spawn: { readonly x: number; readonly y: number }; // founder spawn (px)
}

// Tier 1: the founder's first small office. Tiers 2/3 grow it as you hire.
export const TIERS: ReadonlyArray<OfficeTier> = [
  {
    cols: 13,
    rows: 9,
    floor: "carpet",
    desks: [
      { tx: 2, ty: 3 },
      { tx: 5, ty: 3 },
      { tx: 8, ty: 3 },
    ],
    plants: [{ tx: 10, ty: 6 }, { tx: 1, ty: 6 }],
    spawn: { x: 6 * TILE + 16, y: 6 * TILE },
  },
  {
    cols: 17,
    rows: 11,
    floor: "carpet",
    desks: [
      { tx: 2, ty: 3 },
      { tx: 5, ty: 3 },
      { tx: 8, ty: 3 },
      { tx: 11, ty: 3 },
      { tx: 5, ty: 7 },
      { tx: 8, ty: 7 },
    ],
    plants: [{ tx: 14, ty: 8 }, { tx: 1, ty: 8 }, { tx: 14, ty: 3 }],
    spawn: { x: 8 * TILE, y: 9 * TILE },
  },
  {
    cols: 21,
    rows: 13,
    floor: "carpet",
    desks: [
      { tx: 2, ty: 3 },
      { tx: 5, ty: 3 },
      { tx: 8, ty: 3 },
      { tx: 11, ty: 3 },
      { tx: 14, ty: 3 },
      { tx: 2, ty: 8 },
      { tx: 5, ty: 8 },
      { tx: 8, ty: 8 },
      { tx: 11, ty: 8 },
      { tx: 14, ty: 8 },
    ],
    plants: [{ tx: 18, ty: 10 }, { tx: 1, ty: 10 }, { tx: 18, ty: 3 }, { tx: 18, ty: 6 }],
    spawn: { x: 10 * TILE, y: 11 * TILE },
  },
] as const;

/** Pick the office tier for a given headcount (1 desk free per employee + room to grow). */
export function tierIndexForHeadcount(count: number): number {
  if (count <= 3) return 0;
  if (count <= 6) return 1;
  return 2;
}
