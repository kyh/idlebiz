import rawLayout from "@/renderer/game/office-design.json";
import { DEPTH } from "@/renderer/game/config";
import { objectSpritePath } from "@/renderer/game/office-object-sprite";
import { objectDepth } from "@/shared/office-depth";
import { walkGridOf } from "@/shared/office-grid";
import type { WalkGrid } from "@/shared/office-grid";
import { officeLayoutSchema } from "@/shared/office-layout-schema";
import type {
  OfficeDesign,
  OfficeLayoutData,
  OfficeObjectDef,
  OfficePoi,
  OfficeSeat,
  PixelPoint,
} from "@/shared/office-layout-schema";

export { comparePaintOrder } from "@/shared/office-depth";
export {
  type OfficeLayer,
  type OfficeLayoutData,
  type OfficePoi,
  type OfficeSeat,
  type PixelPoint,
} from "@/shared/office-layout-schema";

interface OfficeObjectPlacement {
  /** The object as authored: its band and floor line, for anything that judges draw order. */
  readonly def: OfficeObjectDef;
  readonly id: string;
  readonly key: string;
  readonly path: string;
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
}

/** The layout as the scene consumes it: where people go, what it walks over, what it draws. */
export interface Office {
  readonly spawn: PixelPoint;
  /** Where hires walk in from and released employees walk out to. */
  readonly door: PixelPoint;
  readonly seats: readonly OfficeSeat[];
  readonly pois: readonly OfficePoi[];
  /** The collision grid the scene walks, probes and paths over; it also carries the world size. */
  readonly grid: WalkGrid;
  readonly placements: readonly OfficeObjectPlacement[];
}

// office-design.json is authored in the in-app office builder (#/ui): every
// structure tile and furnishing is a placed object over an authored collision
// grid with real walkable lanes. The schema (and what each field means) lives
// in shared/office-layout-schema.ts, because main validates the same file
// before it writes it. The bundled default is always the current version (the
// migrating parser is for files from disk), so it parses strictly, at module load.
export const BUNDLED_LAYOUT: OfficeLayoutData = officeLayoutSchema.parse(rawLayout);

/** The office in force: the saved one, else the bundled one. */
export const layoutOf = (design: OfficeDesign): OfficeLayoutData =>
  design.kind === "saved" ? design.layout : BUNDLED_LAYOUT;

/**
 * Spacing between two neighbours in a flat stack. Small enough that a band of
 * STACK_STEP⁻¹ objects (a million) still cannot reach the band above it, so no
 * decal can ever climb out of the ground band or paint over a speech bubble.
 */
const STACK_STEP = 1e-3;

/**
 * Where a placed object draws, given its position in the paint-ordered array.
 *
 * The ground and overhead bands are flat stacks: they have no floor line, so they
 * paint in authored order and `index` alone separates them. Only the entity band
 * y-sorts — furniture and actors share it, sorting on floor contact.
 */
const depthFor = (obj: OfficeObjectDef, index: number): number => {
  switch (obj.layer) {
    case "floor": {
      return DEPTH.ground + STACK_STEP * (index + 1);
    }
    case "overhead": {
      return DEPTH.overhead + STACK_STEP * (index + 1);
    }
    case "object": {
      return objectDepth(obj.anchorY);
    }
    // no default
  }
};

const placementsOf = (objects: OfficeLayoutData["objects"]): readonly OfficeObjectPlacement[] =>
  objects.map((obj, index) => {
    const path = objectSpritePath(obj);
    return {
      def: obj,
      depth: depthFor(obj, index),
      flipX: obj.flipX ?? false,
      flipY: obj.flipY ?? false,
      id: obj.id,
      // keyed by the file, not the id: one id can name two PNGs, and each must paint its own
      key: `office-object-sprite-${path}`,
      path,
      x: obj.x,
      y: obj.y,
    };
  });

/** The layout as the scene reads it: the walk grid and the paint-ordered placements. */
export const officeOf = (layout: OfficeLayoutData): Office => ({
  door: layout.door,
  grid: walkGridOf(layout),
  placements: placementsOf(layout.objects),
  pois: layout.pois,
  seats: layout.seats,
  spawn: layout.spawn,
});
