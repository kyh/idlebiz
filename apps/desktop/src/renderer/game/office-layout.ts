import { unreachable } from "@repo/domain/errors";
import rawLayout from "@/renderer/game/office-design.json";
import { DEPTH, objectDepth } from "@/renderer/game/office-depth";
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

interface OfficeObjectPlacement {
  readonly key: string;
  /** Where the page loads its art: office-design.json names it within public/. */
  readonly url: string;
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

const STACK_STEP = 1e-3;

const depthFor = (obj: OfficeObjectDef, index: number) => {
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

    default: {
      return unreachable(obj);
    }
  }
};

const placementsOf = (objects: OfficeLayoutData["objects"]) =>
  objects.map((obj, index) => ({
    depth: depthFor(obj, index),
    flipX: obj.flipX ?? false,
    flipY: obj.flipY ?? false,
    key: `office-object-sprite-${obj.path}`,
    url: `/${obj.path}`,
    x: obj.x,
    y: obj.y,
  }));

const officeOf = (layout: OfficeLayoutData) =>
  ({
    door: layout.door,
    grid: walkGridOf(layout),
    placements: placementsOf(layout.objects),
    pois: layout.pois,
    seats: layout.seats,
    spawn: layout.spawn,
  }) satisfies Office;

/** The one office there is, frozen in office-design.json. */
export const OFFICE: Office = officeOf(officeLayoutSchema.parse(rawLayout));
