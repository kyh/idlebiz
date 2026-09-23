import { SOLE_OFFSET } from "./character-frame.ts";

// Only entities y-sort, on floor contact. Flat bands keep authored paint order.
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

// The layout schema bounds world height so entityBase + y cannot enter the overhead band.
export const ENTITY_BAND_HEIGHT = DEPTH.overhead - DEPTH.entityBase;

/** Furniture sorts on floor contact; +0.5 wins ties so a character draws behind what they stand at. */
export const objectDepth = (anchorY: number): number => DEPTH.entityBase + anchorY + 0.5;

/** Depth of a character whose origin sits at world `y`, sorted on their soles. */
export const characterDepth = (y: number): number => DEPTH.entityBase + y + SOLE_OFFSET;

export type OfficeLayer = "floor" | "object" | "overhead";

export type PaintOrdered =
  | { readonly layer: "floor" }
  | { readonly layer: "overhead" }
  | { readonly layer: "object"; readonly anchorY: number };

const BAND = { floor: 0, object: 1, overhead: 2 } satisfies Record<OfficeLayer, number>;

/** Back-to-front order. Use a stable sort to preserve authored order inside flat bands. */
export const comparePaintOrder = (a: PaintOrdered, b: PaintOrdered): number =>
  BAND[a.layer] - BAND[b.layer] ||
  (a.layer === "object" && b.layer === "object" ? a.anchorY - b.anchorY : 0);
