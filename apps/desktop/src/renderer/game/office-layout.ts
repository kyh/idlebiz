import rawLayout from "@/renderer/game/office-design.json";
import { DEPTH } from "@/renderer/game/config";
import { objectDepth } from "@/renderer/game/office-depth";
import { walkGridOf } from "@/renderer/game/office-grid";
import type { WalkGrid } from "@/renderer/game/office-grid";
import { officeLayoutSchema } from "@/renderer/game/office-layout-schema";
import type {
  OfficeLayoutData,
  OfficeObjectDef,
  OfficePoi,
  OfficeSeat,
  PixelPoint,
} from "@/renderer/game/office-layout-schema";

export { type PixelPoint } from "@/renderer/game/office-layout-schema";

interface OfficeObjectPlacement {
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
 * paint in file order and `index` alone separates them. Only the entity band
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
  objects.map((obj, index) => ({
    depth: depthFor(obj, index),
    flipX: obj.flipX ?? false,
    flipY: obj.flipY ?? false,
    key: `office-object-sprite-${obj.path}`,
    path: obj.path,
    x: obj.x,
    y: obj.y,
  }));

/** The layout as the scene reads it: the walk grid and the paint-ordered placements. */
const officeOf = (layout: OfficeLayoutData): Office => ({
  door: layout.door,
  grid: walkGridOf(layout),
  placements: placementsOf(layout.objects),
  pois: layout.pois,
  seats: layout.seats,
  spawn: layout.spawn,
});

/** The one office there is, frozen in office-design.json. */
export const OFFICE: Office = officeOf(officeLayoutSchema.parse(rawLayout));
