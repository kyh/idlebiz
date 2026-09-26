import { SOLE_OFFSET } from "@/shared/character-frame";

// Only entities y-sort, on floor contact. Flat bands paint in file order.
export const DEPTH = {
  // bubbles, name labels, "!" — always on top
  emote: 3000,
  // + floor-contact y: furniture, player and npcs sort together here
  entityBase: 1000,
  // floor tiles + decals, always under actors
  ground: 0,
  // props that always draw above actors
  overhead: 2000,
} as const;

/** Furniture sorts on floor contact; +0.5 wins ties so a character draws behind what they stand at. */
export const objectDepth = (anchorY: number): number => DEPTH.entityBase + anchorY + 0.5;

/** Depth of a character whose origin sits at world `y`, sorted on their soles. */
export const characterDepth = (y: number): number => DEPTH.entityBase + y + SOLE_OFFSET;
