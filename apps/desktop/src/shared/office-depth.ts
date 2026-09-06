// Only entities y-sort, on floor contact. Flat bands keep authored paint order.
export const DEPTH = {
  ground: 0, // floor tiles + decals, always under actors
  entityBase: 1000, // + floor-contact y: furniture, player and npcs sort together here
  overhead: 2000, // props that always draw above actors
  emote: 3000, // bubbles, name labels, "!" — always on top
} as const;

// The layout schema bounds world height so entityBase + y cannot enter the overhead band.
export const ENTITY_BAND_HEIGHT = DEPTH.overhead - DEPTH.entityBase;

export type OfficeLayer = "floor" | "object" | "overhead";

export type PaintOrdered =
  | { readonly layer: "floor" }
  | { readonly layer: "overhead" }
  | { readonly layer: "object"; readonly anchorY: number };

const BAND = { floor: 0, object: 1, overhead: 2 } satisfies Record<OfficeLayer, number>;

/** Back-to-front order. Use a stable sort to preserve authored order inside flat bands. */
export function comparePaintOrder(a: PaintOrdered, b: PaintOrdered): number {
  return (
    BAND[a.layer] - BAND[b.layer] ||
    (a.layer === "object" && b.layer === "object" ? a.anchorY - b.anchorY : 0)
  );
}
