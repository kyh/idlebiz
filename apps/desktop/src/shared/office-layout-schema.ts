import { z } from "zod";
import { ENTITY_BAND_HEIGHT } from "./office-depth.ts";
import type { JsonValue } from "./json.ts";

// ---------------------------------------------------------------------------
// office-design.json — the office as data, parsed at every boundary it crosses.
//
// One schema, three readers: the renderer (to build the room), main (to refuse
// a bad layout at save time instead of silently falling back at next boot),
// and scripts/check-office-void.mjs (the static gate). It therefore imports
// nothing from either process — only zod and the band constants — and names
// its relative imports with extensions so node can load it as-is.
//
// Version history:
//   v1 (no `version` key): spawn + workSeats. Idle-life spots were hardcoded
//      in the scene, so a custom office inherited the bundled map's water
//      cooler. Read and upgraded, never written.
//   v2: `version: 2`, seats with roles, points of interest, and a door — the
//      semantic layer the scene used to keep to itself.
// ---------------------------------------------------------------------------

export const OFFICE_LAYOUT_VERSION = 2;

export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

export type OfficeLayer = "floor" | "object" | "overhead";

// `objects` is stored in PAINT ORDER (back to front) — the ground and overhead
// bands have no depth of their own, they simply stack in the order they appear.
// Only the entity band sorts, and it sorts on anchorY. So anchorY exists on the
// object layer and nowhere else: on a flat stack there is nothing for a floor
// line to mean.
/**
 * The tallest floor line the entity band can sort. `depthFor` maps a floor line straight
 * into the band as `entityBase + y`, so a line outside it is not merely mis-sorted — it
 * lands in a neighbouring band and paints under the floor or over the speech bubbles.
 * Characters sort a few px below their origin (characters.ts SOLE_OFFSET), so reserve a
 * sprite height at the top of the band for the ones standing at the world's bottom edge.
 */
const CHAR_FRAME_H = 64;
export const MAX_FLOOR_LINE = ENTITY_BAND_HEIGHT - CHAR_FRAME_H;

/** A floor line the entity band can hold. Custom layouts are user input — bound it here. */
const floorLineSchema = z.number().min(0).max(MAX_FLOOR_LINE);

const rectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const pointSchema = z.object({ x: z.number(), y: z.number() });
const placedSchema = {
  // the id resolves to a catalog sprite when there is no explicit path; an
  // empty one parses and then throws while the room is being built
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  flipX: z.boolean().optional(),
  flipY: z.boolean().optional(),
  path: z.string().optional(),
  bounds: rectSchema.optional(),
};
const objectSchema = z.discriminatedUnion("layer", [
  z.object({ layer: z.literal("floor"), ...placedSchema }),
  z.object({
    layer: z.literal("object"),
    /** World y this sprite contacts the floor at — what actors y-sort against. */
    anchorY: floorLineSchema,
    ...placedSchema,
  }),
  z.object({ layer: z.literal("overhead"), ...placedSchema }),
]);

/** Which way a standing character faces. Matches the walk-sheet strips. */
const facingSchema = z.enum(["down", "left", "right", "up"]);
export type Facing = z.infer<typeof facingSchema>;
/** Which sit strip a seated character plays (the chair's facing). */
const sitSideSchema = z.enum(["left", "right"]);

/**
 * A seat someone can occupy.
 *   work — a workstation. An employee's home: they sit here to work.
 *   rest — a break-room chair. Idle employees drop in and play the sit strip.
 */
const seatSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("work"), x: z.number(), y: z.number() }),
  z.object({ role: z.literal("rest"), x: z.number(), y: z.number(), sit: sitSideSchema }),
]);
export type OfficeSeat = z.infer<typeof seatSchema>;

/** A spot idle employees walk to and face: the water cooler, the printer. */
const poiSchema = z.object({ x: z.number(), y: z.number(), face: facingSchema });
export type OfficePoi = z.infer<typeof poiSchema>;

const worldSchema = {
  tile: z.number(),
  width: z.number(),
  // characters y-sort on their own world y, so the world must fit the band too
  height: floorLineSchema,
  cell: z.number(),
  cols: z.number(),
  rows: z.number(),
  /** Where the founder stands when the office opens. */
  spawn: pointSchema,
  objects: z.array(objectSchema),
  // the walk grid reads anything that is not "1" as open floor
  collision: z.array(z.string().regex(/^[01]+$/, "a collision row is 0s and 1s only")),
};

export const officeLayoutSchema = z.object({
  version: z.literal(OFFICE_LAYOUT_VERSION),
  ...worldSchema,
  /** Where hires walk in from and released employees walk out to. */
  door: pointSchema,
  seats: z.array(seatSchema),
  pois: z.array(poiSchema),
});

/** The pre-semantic layout: workstations only, everything else lived in code. */
const legacyLayoutSchema = z.object({
  // a missing key, not an explicit undefined — zod 4 treats the two differently
  version: z.undefined().optional(),
  ...worldSchema,
  workSeats: z.array(pointSchema),
});

export type OfficeLayoutData = z.infer<typeof officeLayoutSchema>;
/** One placed sprite. Carries an anchorY only on the layer that y-sorts. */
export type OfficeObjectDef = z.infer<typeof objectSchema>;

/**
 * A v1 layout has nowhere for hires to come in from, so the founder's spawn
 * doubles as the door until the builder places a real one. It also has no
 * idle-life spots at all — better an office where nobody visits the cooler
 * than one where they visit a cooler that isn't there.
 */
function upgradeLegacy(legacy: z.infer<typeof legacyLayoutSchema>): OfficeLayoutData {
  const { workSeats, ...world } = legacy;
  return {
    ...world,
    version: OFFICE_LAYOUT_VERSION,
    door: { x: legacy.spawn.x, y: legacy.spawn.y },
    seats: workSeats.map((s) => ({ role: "work", x: s.x, y: s.y })),
    pois: [],
  };
}

/**
 * Validate an arbitrary JSON value as a layout, upgrading an older schema on
 * the way in. Throws with the current schema's complaints when neither fits —
 * a file that matches nothing is far more likely a broken v2 than a v1.
 */
export function parseOfficeLayout(raw: JsonValue): OfficeLayoutData {
  const current = officeLayoutSchema.safeParse(raw);
  if (current.success) return current.data;
  const legacy = legacyLayoutSchema.safeParse(raw);
  if (legacy.success) return upgradeLegacy(legacy.data);
  throw new Error(
    `office layout does not match schema v${OFFICE_LAYOUT_VERSION}:\n${z.prettifyError(current.error)}`,
  );
}

/**
 * Why a layout the type system already accepts still fails the schema: a floor
 * line past the band, a collision row with a stray character. The builder runs
 * this before saving so the reason lands in its status line, not in an IPC error.
 */
export function schemaIssues(layout: OfficeLayoutData): string[] {
  const parsed = officeLayoutSchema.safeParse(layout);
  if (parsed.success) return [];
  return parsed.error.issues.map(
    (issue) => `${issue.path.map((key) => String(key)).join(".")}: ${issue.message}`,
  );
}

/**
 * The layout as it is written to disk: current version stamped, keys in a
 * fixed order, nothing the schema does not know about. `objects` must already
 * be in paint order — that order is the data for the flat bands.
 */
export function canonicalOfficeLayout(layout: OfficeLayoutData): OfficeLayoutData {
  return {
    version: OFFICE_LAYOUT_VERSION,
    tile: layout.tile,
    width: layout.width,
    height: layout.height,
    cell: layout.cell,
    cols: layout.cols,
    rows: layout.rows,
    spawn: { x: layout.spawn.x, y: layout.spawn.y },
    door: { x: layout.door.x, y: layout.door.y },
    seats: layout.seats.map((s) =>
      s.role === "work"
        ? { role: "work", x: s.x, y: s.y }
        : { role: "rest", x: s.x, y: s.y, sit: s.sit },
    ),
    pois: layout.pois.map((p) => ({ x: p.x, y: p.y, face: p.face })),
    objects: layout.objects.map(canonicalObject),
    collision: [...layout.collision],
  };
}

/** The keys every placed object may carry, whichever band it is in. */
interface PlacedFields {
  id: string;
  x: number;
  y: number;
  path?: string;
  flipX?: boolean;
  flipY?: boolean;
  bounds?: z.infer<typeof rectSchema>;
}

/** One object row: optional keys omitted, not nulled, and only the set keys present. */
function canonicalObject(obj: OfficeObjectDef): OfficeObjectDef {
  const placed: PlacedFields = { id: obj.id, x: obj.x, y: obj.y };
  if (obj.path !== undefined) placed.path = obj.path;
  if (obj.flipX) placed.flipX = true;
  if (obj.flipY) placed.flipY = true;
  if (obj.bounds !== undefined) placed.bounds = obj.bounds;
  switch (obj.layer) {
    case "floor":
      return { layer: "floor", ...placed };
    case "overhead":
      return { layer: "overhead", ...placed };
    case "object":
      return { layer: "object", anchorY: obj.anchorY, ...placed };
  }
}
