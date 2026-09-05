import rawLayout from "@/renderer/game/office-design.json";
import { DEPTH } from "@/renderer/game/config";
import { comparePaintOrder } from "@/shared/office-depth";
import type { JsonValue } from "@/shared/json";
import {
  officeLayoutSchema,
  parseOfficeLayout,
  type OfficeLayer,
  type OfficeLayoutData,
  type OfficeObjectDef,
  type OfficePoi,
  type OfficeSeat,
  type PixelPoint,
} from "@/shared/office-layout-schema";
import { walkGridOf, type WalkGrid } from "@/shared/office-grid";
import {
  OFFICE_OBJECT_ASSETS,
  type OfficeObjectVariant as CatalogVariant,
} from "@/renderer/game/office-object-catalog.generated";

export type { OfficeLayer, OfficeLayoutData, OfficePoi, OfficeSeat, PixelPoint };
export { comparePaintOrder, parseOfficeLayout };

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

const OFFICE_OBJECT_SCALE = 32;

// office-design.json is authored in the in-app office builder (#/ui): every
// structure tile and furnishing is a placed object over an authored collision
// grid with real walkable lanes. The schema (and what each field means) lives
// in shared/office-layout-schema.ts, because main validates the same file
// before it writes it. The bundled default is always the current version (the
// migrating parser is for files from disk), so it parses strictly, at module load.
const BUNDLED = officeLayoutSchema.parse(rawLayout);

function catalogVariant(id: string): CatalogVariant | null {
  const asset = OFFICE_OBJECT_ASSETS.find((candidate) => candidate.id === id);
  if (!asset) return null;
  return asset.variants.find((variant) => variant.scale === OFFICE_OBJECT_SCALE) ?? null;
}

function objectTextureKey(id: string): string {
  return `office-object-sprite-${id}`;
}
function resolvePath(obj: OfficeObjectDef): string {
  if (obj.path) return obj.path;
  const variant = catalogVariant(obj.id);
  if (!variant) throw new Error(`Missing office object asset: ${obj.id}`);
  return variant.path;
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
 * paint in authored order and `index` alone separates them. Only the entity band
 * y-sorts — furniture and actors share it, sorting on floor contact (the +0.5
 * biases furniture to win ties, so a character draws behind what they stand at).
 */
function depthFor(obj: OfficeObjectDef, index: number): number {
  switch (obj.layer) {
    case "floor":
      return DEPTH.ground + STACK_STEP * (index + 1);
    case "overhead":
      return DEPTH.overhead + STACK_STEP * (index + 1);
    case "object":
      return DEPTH.entityBase + obj.anchorY + 0.5;
  }
}

function placementsOf(objects: OfficeLayoutData["objects"]): readonly OfficeObjectPlacement[] {
  return objects.map((obj, index) => ({
    def: obj,
    id: obj.id,
    key: objectTextureKey(obj.id),
    path: resolvePath(obj),
    x: obj.x,
    y: obj.y,
    depth: depthFor(obj, index),
    flipX: obj.flipX ?? false,
    flipY: obj.flipY ?? false,
  }));
}

function officeOf(layout: OfficeLayoutData): Office {
  return {
    spawn: layout.spawn,
    door: layout.door,
    seats: layout.seats,
    pois: layout.pois,
    grid: walkGridOf(layout),
    placements: placementsOf(layout.objects),
  };
}

// Both are `let` because the player's saved office overrides the bundled default
// (applyOfficeLayout, called from store.refresh before the scene boots). ES live
// bindings mean importers see the replacement.

/** The full parsed layout in force — what the in-app office builder loads to edit. */
export let OFFICE_LAYOUT_RAW: OfficeLayoutData = BUNDLED;

/** The layout in force, as the scene reads it. */
export let OFFICE: Office = officeOf(BUNDLED);

/**
 * Replace the live office layout (the player's saved office from disk overrides the
 * bundled default). Call BEFORE the Phaser scene boots — store.refresh awaits the
 * disk layout, so preload/buildRoom see the replaced binding. An older schema on
 * disk is upgraded on the way in; a file that fits no schema throws.
 */
export function applyOfficeLayout(raw: JsonValue): void {
  const layout = parseOfficeLayout(raw);
  OFFICE_LAYOUT_RAW = layout;
  OFFICE = officeOf(layout);
}
