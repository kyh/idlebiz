import { z } from "zod";
import { DIRS, FRAME_H, SIT_SIDES } from "./character-frame.ts";
import { ENTITY_BAND_HEIGHT, type OfficeLayer } from "./office-depth.ts";
import type { JsonValue } from "./json.ts";

// Shared by main, renderer and check-office.mjs. Keep imports process-independent
// and use extensions so Node can load this file directly.
// v1 has no version and uses workSeats; v2 adds seat roles, POIs and a door.

export const OFFICE_LAYOUT_VERSION = 2;

export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

export type { OfficeLayer };

// Reserve one sprite height for characters whose soles sort below the world edge.
export const MAX_FLOOR_LINE = ENTITY_BAND_HEIGHT - FRAME_H;

/** A floor line the entity band can hold. Custom layouts are user input — bound it here. */
const floorLineSchema = z.number().min(0).max(MAX_FLOOR_LINE);

const rectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const pointSchema = z.object({ x: z.number(), y: z.number() });
const placedSchema = {
  // Empty ids cannot resolve a catalog sprite when no explicit path is present.
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
const facingSchema = z.enum(DIRS);
export type Facing = z.infer<typeof facingSchema>;
/** Which sit strip a seated character plays (the chair's facing). */
const sitSideSchema = z.enum(SIT_SIDES);

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

// Legacy layouts use spawn as their door; inventing POIs would point at absent furniture.
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

/** Upgrade legacy layouts; when neither schema matches, report the current schema's errors. */
export function parseOfficeLayout(raw: JsonValue): OfficeLayoutData {
  const current = officeLayoutSchema.safeParse(raw);
  if (current.success) return current.data;
  const legacy = legacyLayoutSchema.safeParse(raw);
  if (legacy.success) return upgradeLegacy(legacy.data);
  throw new Error(
    `office layout does not match schema v${OFFICE_LAYOUT_VERSION}:\n${z.prettifyError(current.error)}`,
  );
}

/** Numeric/string bounds the type system cannot enforce, shown by the builder before saving. */
export function schemaIssues(layout: OfficeLayoutData): string[] {
  const parsed = officeLayoutSchema.safeParse(layout);
  if (parsed.success) return [];
  return parsed.error.issues.map(
    (issue) => `${issue.path.map((key) => String(key)).join(".")}: ${issue.message}`,
  );
}

/** Stable disk representation. Objects must already be in paint order for the flat bands. */
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
    seats: layout.seats.map(cloneSeat),
    pois: layout.pois.map(clonePoi),
    objects: layout.objects.map(canonicalObject),
    collision: [...layout.collision],
  };
}

/** Copy only schema fields; work seats must not retain a rest seat's sit side. */
export const cloneSeat = (s: OfficeSeat): OfficeSeat =>
  s.role === "work"
    ? { role: "work", x: s.x, y: s.y }
    : { role: "rest", x: s.x, y: s.y, sit: s.sit };
export const clonePoi = (p: OfficePoi): OfficePoi => ({ x: p.x, y: p.y, face: p.face });

// Match the bundled file's key order and omit false flips to avoid no-op save diffs.
function canonicalObject(obj: OfficeObjectDef): OfficeObjectDef {
  const placed = { id: obj.id, x: obj.x, y: obj.y };
  const row: OfficeObjectDef =
    obj.layer === "object"
      ? { ...placed, layer: "object", anchorY: obj.anchorY }
      : { ...placed, layer: obj.layer };
  if (obj.path !== undefined) row.path = obj.path;
  if (obj.flipX) row.flipX = true;
  if (obj.flipY) row.flipY = true;
  if (obj.bounds !== undefined) row.bounds = obj.bounds;
  return row;
}
