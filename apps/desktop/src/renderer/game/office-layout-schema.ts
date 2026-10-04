import { z } from "zod";
import { DIRS, SIT_SIDES } from "@repo/domain/character-frame";

export interface PixelPoint {
  readonly x: number;
  readonly y: number;
}

const pointSchema = z.object({ x: z.number(), y: z.number() });
const placedSchema = {
  flipX: z.boolean().optional(),
  flipY: z.boolean().optional(),
  /** The PNG it draws, relative to public/. */
  path: z.string().min(1),
  x: z.number(),
  y: z.number(),
};
const objectSchema = z.discriminatedUnion("layer", [
  z.object({ layer: z.literal("floor"), ...placedSchema }),
  z.object({
    /** World y this sprite contacts the floor at — what actors y-sort against. */
    anchorY: z.number(),
    layer: z.literal("object"),
    ...placedSchema,
  }),
  z.object({ layer: z.literal("overhead"), ...placedSchema }),
]);

/** Which way a standing character faces. Matches the walk-sheet strips. */
const facingSchema = z.enum(DIRS);
/** Which sit strip a seated character plays (the chair's facing). */
const sitSideSchema = z.enum(SIT_SIDES);

const seatSchema = z.discriminatedUnion("role", [
  z.object({
    /** Which way its occupant faces their screen. */
    facing: facingSchema,
    role: z.literal("work"),
    x: z.number(),
    y: z.number(),
  }),
  z.object({ role: z.literal("rest"), sit: sitSideSchema, x: z.number(), y: z.number() }),
]);
export type OfficeSeat = z.infer<typeof seatSchema>;

/** A spot idle employees walk to and face: the water cooler, the printer. */
const poiSchema = z.object({ face: facingSchema, x: z.number(), y: z.number() });
export type OfficePoi = z.infer<typeof poiSchema>;

/** The bundled office: what it draws, where people go and what they walk over. */
export const officeLayoutSchema = z.object({
  cell: z.number(),
  // the walk grid reads anything that is not "1" as open floor
  collision: z.array(z.string().regex(/^[01]+$/u, "a collision row is 0s and 1s only")),
  cols: z.number(),
  /** Where hires walk in from and released employees walk out to. */
  door: pointSchema,
  height: z.number(),
  objects: z.array(objectSchema),
  pois: z.array(poiSchema),
  rows: z.number(),
  seats: z.array(seatSchema),
  /** Where the founder stands when the office opens. */
  spawn: pointSchema,
  width: z.number(),
});

export type OfficeLayoutData = z.infer<typeof officeLayoutSchema>;

/** One placed sprite. Carries an anchorY only on the layer that y-sorts. */
export type OfficeObjectDef = z.infer<typeof objectSchema>;
