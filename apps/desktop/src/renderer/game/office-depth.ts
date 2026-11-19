import { SOLE_OFFSET } from "@repo/domain/character-frame";

export const DEPTH = {
  emote: 3000,
  entityBase: 1000,
  ground: 0,
  overhead: 2000,
} as const;

/** Furniture sorts on floor contact; +0.5 wins ties so a character draws behind what they stand at. */
export const objectDepth = (anchorY: number) => DEPTH.entityBase + anchorY + 0.5;

/** Depth of a character whose origin sits at world `y`, sorted on their soles. */
export const characterDepth = (y: number) => DEPTH.entityBase + y + SOLE_OFFSET;
